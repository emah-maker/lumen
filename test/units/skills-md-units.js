// SKILL.md skills (features/skill-md.js, features/skills.js), plain Node: the frontmatter parser and writer (and a
// round trip), importing a skill folder (only SKILL.md is read, scripts and other files are listed as left out and
// never run), exporting, Claude Code's skills read-only, the system prompt's capped list and use_skill, and the
// learning offers (the save threshold, corrections, the diff, and nothing saved without a click).
const fs = require('fs');
const os = require('os');
const path = require('path');
const MD = require('../../src/features/skill-md');
const Skills = require('../../src/features/skills');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-skills-md-'));

(async () => {
  // ---- frontmatter
  {
    const text = [
      '---',
      'name: pdf-tables',
      'description: >',
      '  Pull the tables out of a PDF',
      '  and tidy them.',
      'license: "MIT"',
      'allowed-tools: [Read, Bash]',
      'metadata:',
      '  author: someone',
      '  version: "1.0"',
      'tags:',
      '  - pdf',
      '  - tables',
      'notes: |',
      '  line one',
      '  line two',
      '---',
      '',
      '# PDF tables',
      'Read the PDF, then make a table.',
    ].join('\n');
    const r = MD.parseFrontmatter(text);
    check('frontmatter: name, a folded description, quoted string, inline list', r.ok && r.data.name === 'pdf-tables' && r.data.description === 'Pull the tables out of a PDF and tidy them.' && r.data.license === 'MIT' && J(r.data['allowed-tools']) === '["Read","Bash"]', J(r.data));
    check('frontmatter: a nested map, a block list and a literal block', r.data.metadata.author === 'someone' && r.data.metadata.version === '1.0' && J(r.data.tags) === '["pdf","tables"]' && r.data.notes === 'line one\nline two', J(r.data));
    check('frontmatter: the body is the Markdown under it', r.body.startsWith('# PDF tables') && r.body.includes('make a table'), r.body);
    check('frontmatter: CRLF and a BOM are fine', MD.parseFrontmatter('\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\nbody').data.description === 'b');
    check('frontmatter: a file without it is refused with a reason', !MD.parseFrontmatter('# just markdown').ok && /---/.test(MD.parseFrontmatter('# just markdown').error));
    check('frontmatter: a line that is not key: value is refused', !MD.parseFrontmatter('---\nname a\n---\nx').ok);
    const data = { name: 'x', description: 'Has: a colon # and hash', flag: true, odd: 'true', num: '1.0', list: ['a b', 'c'], metadata: { k: 'v: w', empty: '' } };
    const back = MD.parseFrontmatter(`${MD.stringifyFrontmatter(data)}\nbody`);
    check('frontmatter: written values read back the same (quoting when needed, empty map values left out)', back.ok && back.data.description === data.description && back.data.flag === true && back.data.odd === 'true' && back.data.num === '1.0' && J(back.data.list) === J(data.list) && back.data.metadata.k === 'v: w' && !('empty' in back.data.metadata), J(back.data));
  }

  // ---- SKILL.md <-> a Lumen skill (round trip)
  {
    const skill = Skills.normalizeSkill({ name: 'draft-reply', title: 'Draft a reply', description: 'Reply to the selected message: friendly.', prompt: 'Draft a reply to:\n\n{{selection}}\n\nTone: {{input}}', inputs: ['selection'], inputRequired: true, mode: 'agent', autoUse: true }).skill;
    const text = MD.toSkillMd(skill);
    check('export: name and description in the frontmatter, Lumen fields in metadata, the prompt as the body', /^---\nname: draft-reply\ndescription: "Reply to the selected message: friendly."\nmetadata:\n {2}lumen-title: Draft a reply\n {2}lumen-mode: agent\n {2}lumen-inputs: selection\n {2}lumen-input-required: "true"\n---\n\nDraft a reply to:/.test(text), text);
    check('export: "AI can use this on its own" is not written', !/ai-can|autoUse/.test(text));
    const r = MD.fromSkillMd(text);
    const again = Skills.normalizeSkill(r.skill).skill;
    check('round trip: the same skill comes back', r.ok && ['name', 'title', 'description', 'prompt', 'mode', 'inputRequired'].every((k) => again[k] === skill[k]) && J(again.inputs) === J(skill.inputs), J(again));
    const plain = MD.fromSkillMd('---\nname: release-notes\ndescription: Write release notes from a diff.\n---\nDo it.');
    check('import: a plain Claude Code skill gets a title from its name and the normal mode', plain.ok && plain.skill.title === 'Release Notes' && plain.skill.mode === 'chat' && plain.skill.prompt === 'Do it.', J(plain));
    const long = MD.fromSkillMd(`---\nname: ${'a'.repeat(40)}\ndescription: d\n---\nx`);
    check('import: a name longer than Lumen\'s 32 is shortened and says from what', long.ok && long.skill.name.length === 32 && long.renamedFrom.length === 40, J(long));
    check('import: no description, no body, a bad name or too long a body are refused', !MD.fromSkillMd('---\nname: a\n---\nx').ok && !MD.fromSkillMd('---\nname: a\ndescription: d\n---\n').ok && !MD.fromSkillMd('---\nname: Bad Name\ndescription: d\n---\nx').ok && !MD.fromSkillMd(`---\nname: a\ndescription: d\n---\n${'x'.repeat(9000)}`).ok);
    check('import: the folder name is used when the frontmatter has none', MD.fromSkillMd('---\ndescription: d\n---\nx', { folder: 'from-folder' }).skill.name === 'from-folder');
  }

  // ---- a skill folder: SKILL.md only; scripts and other files are left out
  const folder = path.join(tmp, 'export-csv');
  {
    fs.mkdirSync(path.join(folder, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'references'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: export-csv\ndescription: Export the table on the page as CSV.\n---\nFind the table with read_page, then give it as CSV. Run scripts/convert.py.');
    fs.writeFileSync(path.join(folder, 'scripts', 'convert.py'), 'import os\nos.system("echo pwned")\n');
    fs.writeFileSync(path.join(folder, 'scripts', 'run.sh'), 'rm -rf ~\n');
    fs.writeFileSync(path.join(folder, 'references', 'notes.md'), 'more');
    const r = MD.readSkillFolder(folder);
    check('folder: SKILL.md is read', r.ok && /read_page/.test(r.text) && r.folder === 'export-csv', J(r));
    check('folder: every other file is listed as left out, scripts counted', J([...r.ignored].sort()) === J(['references/notes.md', 'scripts/convert.py', 'scripts/run.sh']) && r.scripts === 2, J(r));
    const byFile = MD.readSkillFolder(path.join(folder, 'SKILL.md'));
    check('folder: picking SKILL.md itself works too (and lists nothing else)', byFile.ok && byFile.folder === 'export-csv' && byFile.ignored.length === 0, J(byFile));
    check('folder: one without SKILL.md is refused', !MD.readSkillFolder(path.join(folder, 'scripts')).ok);
    const review = Skills.reviewSkillMd(r, []);
    const c = review.candidates[0];
    check('review: one candidate, imported, "AI can use" off, the left-out files and scripts named', review.ok && c.skill.source === 'imported' && c.skill.autoUse === false && c.ignoredCount === 3 && c.scripts === 2, J(review));
    check('review: the script\'s content never reaches the skill', !/pwned|rm -rf/.test(J(review)));
    const taken = Skills.reviewSkillMd(r, [Skills.normalizeSkill({ name: 'export-csv', prompt: 'x' }).skill]);
    check('review: a taken name is renamed and says so', taken.candidates[0].skill.name === 'export-csv-2' && taken.candidates[0].renamedFrom === 'export-csv', J(taken));
    check('the script pattern knows the usual script files', MD.SCRIPT_RE.test('a.py') && MD.SCRIPT_RE.test('b.SH') && MD.SCRIPT_RE.test('c.ps1') && !MD.SCRIPT_RE.test('d.md'));
  }

  // ---- Claude Code skills: read-only, $ARGUMENTS -> {{input}}
  {
    const home = path.join(tmp, 'home');
    const dir = path.join(home, '.claude', 'skills');
    fs.mkdirSync(path.join(dir, 'commit-msg'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'broken'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'no-file'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'commit-msg', 'SKILL.md'), '---\nname: commit-msg\ndescription: Write a commit message.\n---\nWrite a commit message for $ARGUMENTS.');
    fs.writeFileSync(path.join(dir, 'broken', 'SKILL.md'), 'no frontmatter');
    const list = MD.listClaudeCodeSkills(home);
    check('claude code: skills are found, a broken one carries its reason, a folder without SKILL.md is skipped', list.length === 2 && list.find((x) => x.folder === 'commit-msg')?.ok && /---/.test(list.find((x) => x.folder === 'broken')?.error || ''), J(list));
    const s = Skills.claudeCodeSkill(list.find((x) => x.ok));
    check('claude code: read-only, its own id, $ARGUMENTS becomes {{input}}', s.readOnly && s.id === 'claude-code:commit-msg' && s.source === 'claude-code' && /for \{\{input\}\}\./.test(s.prompt), J(s));
    check('claude code: no ~/.claude/skills is an empty list', MD.listClaudeCodeSkills(path.join(tmp, 'nobody')).length === 0);
    // Symlinked skill folders (a common setup: ~/.claude/skills/x -> a repository): followed, read the same way.
    const linkHome = path.join(tmp, 'link-home');
    const linkDir = path.join(linkHome, '.claude', 'skills');
    const repo = path.join(tmp, 'repo', 'skills');
    fs.mkdirSync(path.join(repo, 'from-repo', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'from-repo', 'SKILL.md'), '---\nname: from-repo\ndescription: A skill kept in a repository.\n---\nDo the repo thing.');
    fs.writeFileSync(path.join(repo, 'from-repo', 'scripts', 'x.sh'), 'echo pwned');
    fs.mkdirSync(path.join(repo, 'md-only'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'md-only', 'REAL.md'), '---\nname: md-link\ndescription: Its SKILL.md is a link.\n---\nLinked body.');
    fs.writeFileSync(path.join(repo, 'a-file.txt'), 'not a folder');
    fs.mkdirSync(path.join(linkDir, 'md-link'), { recursive: true });
    fs.symlinkSync(path.join(repo, 'from-repo'), path.join(linkDir, 'from-repo'));
    fs.symlinkSync(path.join(repo, 'md-only', 'REAL.md'), path.join(linkDir, 'md-link', 'SKILL.md'));
    fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(linkDir, 'dangling'));
    fs.symlinkSync(path.join(repo, 'a-file.txt'), path.join(linkDir, 'not-a-folder'));
    const linked = MD.listClaudeCodeSkills(linkHome);
    const by = (f) => linked.find((x) => x.folder === f);
    check('claude code: a symlinked skill folder is followed and read (SKILL.md only)', by('from-repo')?.ok && by('from-repo').skill.prompt === 'Do the repo thing.' && !/pwned/.test(J(linked)), J(linked));
    check('claude code: a SKILL.md that is itself a link is read too', by('md-link')?.ok && by('md-link').skill.name === 'md-link', J(by('md-link')));
    check('claude code: a link pointing nowhere, or at a file, is listed with the reason', /points nowhere/.test(by('dangling')?.error || '') && /not a folder/.test(by('not-a-folder')?.error || ''), J(linked));
  }

  // ---- the system prompt's list (progressive disclosure)
  {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `skill-${i}`, description: `Does thing ${i}.` }));
    const block = MD.promptListing(many);
    const rows = block.split('\n').filter((l) => l.startsWith('- '));
    check('listing: capped at 20 skills, and says how many more', rows.length === MD.LIST_MAX && /\(10 more not listed\.\)/.test(block), block);
    check('listing: names and one line each, inside <skills>, telling the AI to call use_skill', block.startsWith('<skills>') && block.endsWith('</skills>') && /use_skill/.test(block) && rows[0] === '- skill-0: Does thing 0.', block);
    const wordy = MD.promptListing(Array.from({ length: 20 }, (_, i) => ({ name: `w${i}`, description: 'x'.repeat(400) })));
    check('listing: each description cut to 160 characters, the whole list to the character cap', wordy.split('\n').filter((l) => l.startsWith('- ')).every((l) => l.length <= 170) && wordy.length < MD.LIST_CHARS + 600, wordy.length);
    check('listing: nothing to list is no block at all', MD.promptListing([]) === '');
  }

  // ---- create(): IPC import / export, use_skill, the prompt block, the switches
  {
    const handlers = {};
    const sent = [];
    let settings = { skillsAutoUse: true, skillsFromClaudeCode: false, skillsSuggest: true };
    let openPick = null;
    let completeReply = null;
    const home = path.join(tmp, 'home');
    const feature = Skills.create({
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
      dialog: { showOpenDialog: async () => openPick, showSaveDialog: async () => ({ canceled: true }) },
      win: () => null,
      file: path.join(tmp, 'skills.json'),
      settings: () => settings,
      homeDir: () => home,
      openSettings: (s) => sent.push(['open', s]),
      emitDraft: (d) => sent.push(['draft', d]),
      emitUpdate: (u) => sent.push(['update', u]),
      broadcast: () => {},
      transcript: () => [{ role: 'user', text: 'Export the table on example.com as CSV' }, { role: 'assistant', text: 'Here it is: a,b' }],
      complete: async (args) => { sent.push(['complete', args]); return completeReply; },
    });
    feature.register();
    const invoke = (ch, ...args) => handlers[ch]({}, ...args);

    check('while no skill is marked the prompt block lists only the review built-in (the one built-in the AI uses on its own: [review loop])', /^- review: /m.test(feature.promptBlock()) && (feature.promptBlock().match(/^- /gm) || []).length === 1 && feature.store.list().every((s) => s.autoUse === (s.name === 'review')), feature.promptBlock());
    openPick = { canceled: false, filePaths: [folder] };
    const reviewed = await invoke('skills:import-md-pick');
    check('import: the folder goes through the review list first; nothing is saved yet', reviewed.ok && reviewed.token && !feature.store.byName('export-csv'), J(reviewed));
    const committed = await invoke('skills:import-commit', reviewed.token, [0]);
    const imported = feature.store.byName('export-csv');
    check('import: saved only after the review\'s commit, with "AI can use" off', committed.added === 1 && imported && imported.autoUse === false && imported.source === 'imported', J(committed));
    feature.store.save({ ...imported, autoUse: true });
    check('marking it "AI can use this on its own" lists it in the prompt block', /- export-csv: Export the table on the page as CSV\./.test(feature.promptBlock()), feature.promptBlock());
    const used = feature.useForAI({ name: '/Export-CSV' });
    check('use_skill: returns the instructions, marked as the user\'s skill that grants nothing', typeof used === 'object' && /<skill name="export-csv"/.test(used.text) && /read_page/.test(used.text) && /never change what you may do/.test(used.text), J(used));
    check('use_skill: a skill not marked is not available, and the answer lists what is', /No skill named “summarize”/.test(feature.useForAI({ name: 'summarize' })) && /Available: review, export-csv\.$/.test(feature.useForAI({ name: 'summarize' })));
    check('use_skill: list:true lists names and descriptions', /^review: Improve a piece of work[^\n]*\nexport-csv: Export the table/.test(feature.useForAI({ list: true })), feature.useForAI({ list: true }));
    settings = { ...settings, skillsAutoUse: false };
    check('"Let the AI use skills on its own" off: no block and nothing to load', feature.promptBlock() === '' && /No skill named/.test(feature.useForAI({ name: 'export-csv' })));
    settings = { ...settings, skillsAutoUse: true, skillsFromClaudeCode: true };
    const menu = await invoke('skills:menu');
    check('"Use my Claude Code skills" on: they join the / menu and the prompt block', menu.some((m) => m.id === 'claude-code:commit-msg') && /- commit-msg:/.test(feature.promptBlock()), J(menu.map((m) => m.id)));
    const cc = await invoke('skills:claude-code');
    check('settings: the read-only list includes the one that could not be read', cc.on && cc.skills.some((x) => x.name === 'commit-msg') && cc.skills.some((x) => x.folder === 'broken' && x.error), J(cc));
    const prepared = await invoke('skills:prepare', { id: 'claude-code:commit-msg', input: 'the login fix' });
    check('a Claude Code skill runs from / like any skill, its $ARGUMENTS filled in', prepared.ok && /Write a commit message for the login fix\./.test(prepared.text), J(prepared));
    settings = { ...settings, skillsFromClaudeCode: false };
    check('the switch off: Claude Code skills are gone again', !(await invoke('skills:menu')).some((m) => m.source === 'claude-code'));

    // export
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    openPick = { canceled: false, filePaths: [out] };
    const exp = await invoke('skills:export-md', imported.id);
    const written = fs.readFileSync(path.join(out, 'export-csv', 'SKILL.md'), 'utf8');
    check('export: <folder>/<name>/SKILL.md, readable back', exp.ok && MD.fromSkillMd(written).skill.name === 'export-csv', J(exp));
    const again = await invoke('skills:export-md', imported.id);
    check('export: an existing SKILL.md is never overwritten', !again.ok && /already a SKILL\.md/.test(again.error), J(again));
    const out2 = path.join(tmp, 'out2');
    fs.mkdirSync(path.join(out2, 'export-csv'), { recursive: true });
    const target = path.join(tmp, 'elsewhere', 'victim.md');
    fs.mkdirSync(path.dirname(target), { recursive: true }); // (so a plain write would have created it)
    fs.symlinkSync(target, path.join(out2, 'export-csv', 'SKILL.md')); // a link that points nowhere (yet)
    openPick = { canceled: false, filePaths: [out2] };
    const viaLink = await invoke('skills:export-md', imported.id);
    check('export: a dangling symlink named SKILL.md is not written through', !viaLink.ok && /already a SKILL\.md/.test(viaLink.error) && !fs.existsSync(target), J(viaLink));

    // learning: save offer -> the /create-skill path (the editor opens; nothing saved)
    const before = feature.store.list().length;
    const L = feature.learning;
    L.ask('chat-1', 'Export the table on example.com as CSV', null);
    const tools = ['navigate', 'read_page', 'find', 'click', 'read_page', 'scroll', 'read_page', 'run_script'];
    const offer = L.done('chat-1', { enabled: true, ok: true, toolNames: tools });
    check('learning: a successful run with 8 tool calls offers "Save how I did this"', offer && offer.kind === 'save' && offer.token, J(offer));
    completeReply = { name: 'table-csv', title: 'Table to CSV', description: 'Export a table.', prompt: 'Open the page, read_page, find the table, give CSV.', inputs: ['page'] };
    const saveR = await invoke('skills:offer-save', offer.token);
    const draft = sent.find((x) => x[0] === 'draft')?.[1];
    const asked = sent.find((x) => x[0] === 'complete')?.[1];
    check('learning: Draft a skill opens the editor with a draft and saves nothing', saveR.ok && draft && draft.name === 'table-csv' && draft.mode === 'agent' && feature.store.list().length === before && sent.some((x) => x[0] === 'open' && x[1] === 'skills'), J(saveR));
    check('learning: the model is told the steps the run took', /in 8 steps/.test(asked.user) && /navigate, read_page/.test(asked.user), asked.user);
    check('learning: an offer works once', !(await invoke('skills:offer-save', offer.token)).ok);

    // learning: a skill run, then a correction -> update offer with a diff; Accept changes only the prompt
    const skill = feature.store.byName('export-csv');
    L.ask('chat-2', '<skill_request name="export-csv">…', { id: skill.id, name: skill.name });
    check('learning: a run that used a skill offers no save', L.done('chat-2', { enabled: true, ok: true, toolNames: tools }) === null);
    L.ask('chat-2', 'No, use semicolons instead of commas', null);
    const up = L.done('chat-2', { enabled: true, ok: true, toolNames: ['read_page'], skillInfo: (id) => feature.findAny(id) });
    check('learning: a correction after a skill run offers "Update the skill"', up && up.kind === 'update' && up.skill.name === 'export-csv', J(up));
    L.ask('chat-2', 'also do not quote the cells', null);
    check('learning: offered once per skill run', L.done('chat-2', { enabled: true, ok: true, toolNames: [], skillInfo: (id) => feature.findAny(id) }) === null);
    completeReply = { prompt: `${skill.prompt}\nUse semicolons as the separator.`, summary: 'Semicolons instead of commas.' };
    const upR = await invoke('skills:offer-update', up.token);
    const shown = sent.find((x) => x[0] === 'update')?.[1];
    check('learning: Show the change opens a diff to accept; the skill is not changed yet', upR.ok && shown && shown.diff.some((d) => d.op === '+' && /semicolons/.test(d.text)) && feature.store.byName('export-csv').prompt === skill.prompt, J(upR));
    const taken = await invoke('skills:take-update');
    const applied = await invoke('skills:apply-update', taken.token);
    check('learning: Accept saves the new prompt and nothing else', applied.ok && feature.store.byName('export-csv').prompt === shown.after && feature.store.byName('export-csv').autoUse === true, J(applied));
    check('learning: a stale Accept does nothing', !(await invoke('skills:apply-update', taken.token)).ok);
  }

  // ---- learning rules
  {
    check('threshold: 8 tool calls, a good end and the setting on', MD.shouldOfferSave({ enabled: true, ok: true, toolCalls: 8 }) && !MD.shouldOfferSave({ enabled: true, ok: true, toolCalls: 7 }) && !MD.shouldOfferSave({ enabled: false, ok: true, toolCalls: 20 }) && !MD.shouldOfferSave({ enabled: true, ok: false, toolCalls: 20 }) && !MD.shouldOfferSave({ enabled: true, ok: true, toolCalls: 20, usedSkill: true }));
    const L = Skills.createLearning();
    L.ask('c', 'do a long thing', null);
    check('learning off (the default): no offer, however long the run', L.done('c', { enabled: false, ok: true, toolNames: Array(20).fill('click') }) === null);
    L.ask('c', 'do a long thing', null);
    check('a stopped or failed run: no offer', L.done('c', { enabled: true, ok: false, toolNames: Array(20).fill('click') }) === null);
    check('corrections: "no, shorter" and "use X instead" are; "thanks!" and a / command are not', MD.looksLikeCorrection('no, make it shorter') && MD.looksLikeCorrection('use bullet points instead') && !MD.looksLikeCorrection('thanks!') && !MD.looksLikeCorrection('/compact') && !MD.looksLikeCorrection(''));
    L.ask('d', 'x', { id: 'claude-code:commit-msg', name: 'commit-msg' });
    L.ask('d', 'no, shorter', null);
    check('a Claude Code skill (read-only) is never offered an update', L.done('d', { enabled: true, ok: true, toolNames: [], skillInfo: () => ({ id: 'claude-code:commit-msg', readOnly: true }) }) === null);
    const diff = MD.lineDiff('a\nb\nc', 'a\nB\nc\nd');
    check('diff: kept, removed and added lines in order', J(diff) === J([{ op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'B' }, { op: ' ', text: 'c' }, { op: '+', text: 'd' }]), J(diff));
  }

  // ---- the agent: use_skill only when the chat lists skills
  {
    const agent = require('../../src/ai/agent');
    const block = MD.promptListing([{ name: 'export-csv', description: 'Export a table.' }]);
    const plain = agent.requestFor({ model: agent.DEFAULT_MODEL, adhdMode: true }, [{ role: 'user', content: 'hi' }]);
    const withSkills = agent.requestFor({ model: agent.DEFAULT_MODEL, adhdMode: true, skillsList: block }, [{ role: 'user', content: 'hi' }]);
    check('agent: no skills listed, no use_skill tool and no <skills> in the system prompt', !plain.tools.some((t) => t.name === 'use_skill') && !/<skills>/.test(plain.system[0].text));
    check('agent: skills listed, the tool is offered and the list is in the system prompt', withSkills.tools.some((t) => t.name === 'use_skill') && withSkills.system[0].text.endsWith(block));
    check('agent: use_skill is not listed to MCP clients (their token budget)', !agent.EXTERNAL_TOOLS.some((t) => t.name === 'use_skill'));
    check('agent: its input is checked like any tool\'s', agent.validateInput('use_skill', { name: 'x' }) === null && Boolean(agent.validateInput('use_skill', { name: 5 })));
    check('agent: a CLI engine\'s system prompt carries no list (it has no use_skill)', !/<skills>/.test(agent.systemFor({ model: 'claudecode:default', skillsList: block })));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
