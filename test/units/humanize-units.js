// [humanize] Humanize in plain Node: it runs the user's own humanizer skill (found through features/skills.js, never a copy of rules of
// Lumen's own), the prompt is the skill's instructions plus the embedded-mode note, the answer is parsed, kept facts are checked, the
// model choice follows the chat's own AI, run() never throws, and a missing skill is an error that names Settings → Skills.
// Also the wiring the feature relies on (menu items, IPC rules, the lazy loads).
const fs = require('fs');
const os = require('os');
const path = require('path');
const hz = require('../../src/ai/humanize');
const skills = require('../../src/features/skills');
const skillMd = require('../../src/features/skill-md');

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail ?? '').slice(0, 400)}`}`); if (!ok) failures++; };
const root = path.join(__dirname, '..', '..');
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---- the skill: a humanizer SKILL.md in a temp ~/.claude/skills, longer than the old 20,000-character cap (the real one is ~33,000)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-hz-home-'));
const BODY = `# Humanizer: remove AI writing patterns\n\nRewrite AI-sounding text so it reads like the writer. SKILL-MARKER-7731.\n\n${'## A pattern\n\nWatch for: not X but Y. Keep every fact.\n\n'.repeat(560)}`;
fs.mkdirSync(path.join(home, '.claude', 'skills', 'humanizer'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'skills', 'humanizer', 'SKILL.md'), `---\nname: humanizer\ndescription: Rewrite AI-sounding text so it reads like the writer.\n---\n\n${BODY}`);
check('fixture: the skill is longer than 20,000 characters', BODY.length > 20000 && BODY.length < 40000, BODY.length);
const listed = skillMd.listClaudeCodeSkills(home).find((e) => e.folder === 'humanizer');
check('skills: a Claude Code skill up to 40,000 characters is read (was refused over 20,000)', listed?.ok && listed.skill.prompt.includes('SKILL-MARKER-7731'), JSON.stringify(listed)?.slice(0, 200));
const big = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-hz-big-'));
fs.mkdirSync(path.join(big, '.claude', 'skills', 'big'), { recursive: true });
fs.writeFileSync(path.join(big, '.claude', 'skills', 'big', 'SKILL.md'), `---\nname: big\ndescription: x\n---\n\n${'y'.repeat(40001)}`);
check('skills: one over 40,000 is still refused, with the reason', /40000/.test(skillMd.listClaudeCodeSkills(big)[0]?.error || ''), JSON.stringify(skillMd.listClaudeCodeSkills(big)[0]));
const make = (settings, h = home) => skills.create({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-hz-store-')), 'skills.json'), settings: () => settings, homeDir: () => h });
const on = make({ skillsFromClaudeCode: true }).humanizer();
check('skills.humanizer: the Claude Code skill, as skills.js hands any skill to the AI (forAI)', on.skill?.name === 'humanizer' && on.skill.source === 'claude-code' && on.text === skills.forAI(skills.claudeCodeSkill({ folder: 'humanizer', skill: listed.skill })) && on.text.includes('SKILL-MARKER-7731'), JSON.stringify(on.skill));
check('skills.humanizer: there but "Use my Claude Code skills" off: skills-off', make({ skillsFromClaudeCode: false }).humanizer().error === 'skills-off');
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-hz-empty-'));
check('skills.humanizer: no such skill anywhere: missing', make({ skillsFromClaudeCode: true }, empty).humanizer().error === 'missing' && make({}, empty).humanizer().error === 'missing');
const own = make({ skillsFromClaudeCode: true }, empty);
own.store.save({ name: 'humanizer', title: 'My humanizer', description: 'mine', prompt: 'Make it sound human. OWN-MARKER.', inputs: [] });
const mine = own.humanizer();
check('skills.humanizer: a Lumen skill named humanizer works too', mine.skill?.title === 'My humanizer' && mine.text?.includes('OWN-MARKER'), JSON.stringify(mine));
check('humanize.js carries no writing rules of its own', !/RULES|VOICE|TELL_TESTS|delve|pivotal|em dash/i.test(src('src/ai/humanize.js').replace(/\/\/[^\n]*/g, '')), '');

// ---- the prompt: the skill's text, then the embedded-mode note
const system = hz.buildSystem({ skillText: on.text, kind: 'selection' });
check('prompt: starts with the skill\'s instructions, unchanged', system.startsWith(on.text.trim()));
check('prompt: embedded mode, no tools, only the final text in <rewrite>', /embedded mode/.test(system) && /no tools/.test(system) && /Reply with only the final text inside <rewrite><\/rewrite>/.test(system));
check('prompt: a text box keeps its line breaks and gets no Markdown; a reply keeps its Markdown', /keep its line breaks and add no Markdown/.test(system) && /keep its Markdown/.test(hz.buildSystem({ skillText: 'x', kind: 'reply' })));
const msgs = hz.buildMessages({ text: 'Hello <b>there</b>' });
check('messages: one user message with the text in its own tag', msgs.length === 1 && msgs[0].role === 'user' && msgs[0].content.includes('<text_to_rewrite>\nHello <b>there</b>\n</text_to_rewrite>'), JSON.stringify(msgs));

// ---- parsing the model's answer
check('parse: the inside of <rewrite>', hz.parseReply('Sure! <rewrite>\nThe rewrite.\n</rewrite> Hope that helps') === 'The rewrite.');
check('parse: the last <rewrite> when the skill shows a first draft too', hz.parseReply('<rewrite>Draft.</rewrite>\nTells left: none\n<rewrite>Final.</rewrite>') === 'Final.');
check('parse: a cut-off <rewrite> still gives its text', hz.parseReply('<rewrite>Half of it') === 'Half of it');
check('parse: no tags: a lead-in line and a fence go', hz.parseReply('Here is the rewritten text:\n\n```\nPlain words.\n```') === 'Plain words.');
check('parse: keeps line breaks and lists inside', hz.parseReply('<rewrite>Hi Sam,\n\n- one\n- two\n\nThanks</rewrite>') === 'Hi Sam,\n\n- one\n- two\n\nThanks');
check('parse: empty answer is empty', hz.parseReply('') === '' && hz.parseReply(null) === '');

// ---- what must be kept
const original = 'Revenue grew 12,000 units (14.5%) in Q3 — see https://example.com/report and run `npm test`. Ping @dana about {name}.\n```js\nconst x = 1;\n```';
const good = 'Revenue grew 12000 units (14.5%) in Q3. See https://example.com/report and run `npm test`. Ping @dana about {name}.\n```js\nconst x = 1;\n```';
check('kept: nothing missing when numbers, links, code, mentions and placeholders survive', hz.missingFacts(original, good).length === 0, JSON.stringify(hz.missingFacts(original, good)));
const lost = hz.missingFacts(original, 'Revenue grew a lot in Q3. See the report and run the tests. Ping Dana.');
check('kept: a dropped number, link, code span, code block, mention and placeholder are all named', ['14.5%', 'https://example.com/report', '`npm test`', '@dana', '{name}', '12,000'].every((x) => lost.includes(x)) && lost.some((x) => x.startsWith('```')), JSON.stringify(lost));

// ---- commands
check('command: /humanize <text>', hz.parseCommand('/humanize  Some text here') === 'Some text here');
check('command: /humanize alone gives "" (the last reply)', hz.parseCommand('/humanize') === '');
check('command: "humanize this:" with the text on the next line', hz.parseCommand('Humanize this:\nDear team, I hope this finds you well.') === 'Dear team, I hope this finds you well.');
check('command: an ordinary message is not one', hz.parseCommand('can you humanize this later?') === null && hz.parseCommand('hello') === null);
const phrase = /const HUMANIZE_PHRASE = (\/.*\/i);/.exec(src('src/renderer/chat-commands.js'));
const re = phrase ? (0, eval)(phrase[1]) : null; // eslint-disable-line no-eval
check('command: the chat box\'s "humanize this" matches the same phrase as parseCommand', re && re.exec('humanize this:\nDear team, it is a pivotal moment.')?.[1].trim() === hz.parseCommand('humanize this:\nDear team, it is a pivotal moment.'), phrase?.[1]);

// ---- which model rewrites
const options = [{ id: 'claude-sonnet-5-5' }, { id: 'openai:gpt-6' }, { id: 'claudecode:sonnet' }];
const p1 = hz.plan({ chatModel: 'claude-opus-5-5', options });
check('plan: an API chat uses its own provider\'s cheaper model, the chat\'s model as the fallback', p1.kind === 'api' && p1.model === 'claude-haiku-5-5' && p1.own === 'claude-opus-5-5', JSON.stringify(p1));
check('plan: helpers on "same model" keep the chat\'s model', hz.plan({ chatModel: 'openai:gpt-6', mode: 'same' }).model === 'openai:gpt-6');
check('plan: OpenAI uses its mini sibling', hz.plan({ chatModel: 'openai:gpt-6' }).model === 'openai:gpt-6-mini');
const p2 = hz.plan({ chatModel: 'claudecode:opus', options });
check('plan: a Claude Code chat runs Claude Code itself, on Haiku, its own model as the fallback', p2.kind === 'cli' && p2.engine === 'claudecode' && p2.model === 'haiku' && p2.own === 'opus', JSON.stringify(p2));
const p3 = hz.plan({ chatModel: 'grokbuild:default', options });
check('plan: Grok Build and Antigravity run their own CLI', p3.kind === 'cli' && p3.engine === 'grokbuild' && p3.model === 'default' && hz.plan({ chatModel: 'antigravity:gemini-pro' }).engine === 'antigravity', JSON.stringify(p3));
const p4 = hz.plan({ chatModel: 'codex:sol', options });
check('plan: Codex (no one-shot runner) uses its vendor\'s API model', p4.kind === 'api' && /^openai:/.test(p4.model), JSON.stringify(p4));
check('plan: nothing connected and no Claude Code: no provider', hz.plan({ chatModel: '', options: [] }) === null);
const p5 = hz.plan({ chatModel: '', options: [], local: true });
check('plan: nothing connected but Claude Code signed in: Claude Code on Haiku', p5?.kind === 'cli' && p5.engine === 'claudecode' && p5.model === 'haiku', JSON.stringify(p5));
check('plan: "auto" is never sent as a model', hz.plan({ chatModel: 'auto', defaultModel: 'claude-sonnet-5-5' }).own === 'claude-sonnet-5-5');

// ---- run(): the call, the fallbacks, the result
(async () => {
  const seen = [];
  let refuse = false;
  const api = async (model, args) => {
    seen.push({ model, system: args.system, user: args.messages[0].content });
    if (model === 'claude-haiku-5-5' && refuse) throw Object.assign(new Error('model not found'), { status: 404 });
    return { content: [{ type: 'text', text: '<rewrite>The institute opened in 1989.</rewrite>' }], usage: { input_tokens: 10, output_tokens: 5 } };
  };
  const usage = [];
  const text = 'The institute was founded in 1989, marking a pivotal moment.';
  const r = await hz.run({ text, skill: on, chatModel: 'claude-opus-5-5', api, onUsage: (m, model) => usage.push(model) });
  check('run: ok, on the cheaper model, the skill\'s instructions as the system prompt and the text in the message', r.ok && r.model === 'claude-haiku-5-5' && seen[0].system === hz.buildSystem({ skillText: on.text, kind: 'selection' }) && seen[0].user.includes(text), JSON.stringify(r));
  check('run: the rewrite comes back without the tags, 1989 kept, usage counted', r.text === 'The institute opened in 1989.' && r.missing.length === 0 && usage[0] === 'claude-haiku-5-5', JSON.stringify(r));
  check('run: no skill: an error naming the skill, before any model call', (await hz.run({ text, skill: { error: 'missing' }, chatModel: 'claude-opus-5-5', api })).error === 'no-skill' && (await hz.run({ text, skill: { error: 'skills-off' }, chatModel: 'claude-opus-5-5', api })).error === 'skills-off' && (await hz.run({ text, skill: null, api })).error === 'no-skill' && seen.length === 1);
  seen.length = 0; refuse = true;
  const r2 = await hz.run({ text, skill: on, chatModel: 'claude-opus-5-5', api });
  check('run: a refused cheaper model falls back to the chat\'s own once', r2.ok && r2.model === 'claude-opus-5-5' && seen.map((s) => s.model).join() === 'claude-haiku-5-5,claude-opus-5-5', JSON.stringify(seen.map((s) => s.model)));
  const cliSeen = [];
  const r3 = await hz.run({ text: 'Great question! Here is the answer.', skill: on, chatModel: 'claudecode:sonnet', cli: async (a) => { cliSeen.push(a); return '<rewrite>Here is the answer.</rewrite>'; } });
  check('run: a Claude Code chat goes through its CLI with the same skill prompt', r3.ok && r3.kind === 'cli' && cliSeen[0].engine === 'claudecode' && cliSeen[0].model === 'haiku' && cliSeen[0].system === hz.buildSystem({ skillText: on.text }) && /Great question/.test(cliSeen[0].user) && r3.text === 'Here is the answer.', JSON.stringify(r3));
  const r4 = await hz.run({ text: 'x'.repeat(hz.MAX_CHARS + 1), skill: on, chatModel: 'claude-opus-5-5', api });
  check('run: too long is refused before any call', !r4.ok && r4.error === 'too-long' && r4.max === hz.MAX_CHARS);
  check('run: empty text and no provider are errors, not throws', (await hz.run({ text: '  ', skill: on, api })).error === 'empty' && (await hz.run({ text: 'hi', skill: on, chatModel: '', options: [], api })).error === 'no-provider');
  const r5 = await hz.run({ text: 'hi there', skill: on, chatModel: 'claude-opus-5-5', api: async () => { throw Object.assign(new Error('overloaded_error\nmore'), { status: 529 }); } });
  check('run: a failing model is a one-line error', !r5.ok && r5.error === 'overloaded_error', JSON.stringify(r5));
  const r6 = await hz.run({ text: 'hi there', skill: on, chatModel: 'claude-opus-5-5', timeMs: 30, api: (m, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  check('run: a hung model times out', !r6.ok && r6.error === 'timeout', JSON.stringify(r6));
  const r7 = await hz.run({ text: 'lol same', skill: on, chatModel: 'claude-opus-5-5', api: async () => ({ content: [{ type: 'text', text: '<rewrite>lol same</rewrite>' }] }) });
  check('run: text that needs nothing comes back marked unchanged', r7.ok && r7.unchanged === true);

  // ---- wiring
  const main = src('src/main.js');
  check('wiring: Humanize is on the page menu for editable and read-only selections', (main.match(/label: t\('menu\.humanize'\)/g) || []).length === 2 && /humanizeRt\.fromMenu\(wc, p\)/.test(main));
  check('wiring: the runtime loads lazily (nothing new at startup) and gets the skill from skills.js', /const humanizeRt = lazy\(\(\) => require\('\.\/features\/humanize-page'\)/.test(main) && /skill: \(\) => skillsFeature\.humanizer\(\)/.test(main) && !/^const .*require\('\.\/ai\/humanize'\)/m.test(main));
  check('wiring: no natural-voice setting or prompt add-on', !/naturalVoice|aiNaturalVoice/.test(main + src('src/ai/agent.js') + src('src/settings/settings-backend.js')));
  check('wiring: agent:humanize is allowed from the sidebar and the chat page', /'agent:humanize', 'agent:humanize-cancel'/.test(main) && /'agent:humanize', 'agent:humanize-cancel'/.test(src('src/features/chat-page.js')));
  check('wiring: both preloads expose it', /humanize: \(text, kind\) => ipcRenderer\.invoke\('agent:humanize'/.test(src('src/preload/preload.js')) && /humanize: \(text, kind\) => ipcRenderer\.invoke\('agent:humanize'/.test(src('src/features/chat-preload.js')));
  check('wiring: the chat\'s Humanize code is not in the startup bundle (loaded on first use)', !src('src/renderer/index.src.html').includes('humanize.js') && !src('src/renderer/chat-page.html').includes('humanize.js') && /src: 'humanize\.js'/.test(src('src/renderer/chat-actions.js')));
  check('wiring: /humanize is a reserved name skills cannot take', skills.RESERVED.has('humanize'));
  const en = JSON.parse(src('src/locales/en.json'));
  const used = new Set([...src('src/features/humanize-page.js').matchAll(/t\('(humanize\.[\w.]+)'/g), ...src('src/renderer/humanize.js').matchAll(/tr\('(humanize\.[\w.]+)'/g), ...src('src/renderer/chat-actions.js').matchAll(/t\('(humanize\.[\w.]+)'/g)].map((m) => m[1]));
  check('strings: every humanize.* key used is in en.json', [...used].every((k) => typeof en[k] === 'string') && en['menu.humanize'] === 'Humanize', [...used].filter((k) => typeof en[k] !== 'string').join());
  check('strings: the missing-skill message names Settings → Skills', en['humanize.noSkill'] === 'Humanize needs the humanizer skill: add it under Settings → Skills.');

  for (const d of [home, empty, big]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
