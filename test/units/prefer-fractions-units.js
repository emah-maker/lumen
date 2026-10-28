// Prefer fractions (Settings → AI): the system-prompt block (only when on, every engine, inside the Grok prompt budget) and the
// markdown converter that stacks a plain 3/4 (renderer/markdown.js fractionize). Plain Node: no Electron, no network.
const fs = require('fs');
const path = require('path');
const agentLib = require('../../src/ai/agent');
const md = require('../../src/renderer/markdown');
const { validate, DEFAULTS } = require('../../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const B = String.fromCharCode(92);

// ---- the setting
check('setting: off by default, a boolean', DEFAULTS.aiPreferFractions === false && validate('aiPreferFractions', true) === true && validate('aiPreferFractions', 'yes') === null);
check('setting: reaches the UI through prefs:ui and Settings has the switch', /preferFractions: p\.aiPreferFractions === true/.test(read('src/settings/settings-backend.js')) && /toggle\('aiPreferFractions'/.test(read('src/renderer/settings.js')));
check('setting: the chat gets it with each new conversation (main.js getOptions)', /preferFractions: readSettings\(\)\.aiPreferFractions === true/.test(read('src/main.js')));

// ---- the prompt block
const MARK = 'Fractions: exact values as LaTeX';
const base = { model: 'claude-opus-5', adhdMode: true };
check('prompt: absent by default', !agentLib.systemFor(base).includes(MARK) && !agentLib.systemFor({ ...base, preferFractions: false }).includes(MARK));
const on = agentLib.systemFor({ ...base, preferFractions: true });
check('prompt: present when on, and says what to do', on.includes(MARK) && on.includes(`${B}frac{4}{3}`) && /never 4\/3 or 1\.333/.test(on) && /keep √, π/.test(on) && /requested decimals stay/.test(on) && /Measured data stays/.test(on) && /parentheses/.test(on));
check('prompt: also without ADHD mode', agentLib.systemFor({ model: 'claude-opus-5', preferFractions: true }).includes(MARK));
const engines = { claudecode: 'claudecode:default', grokbuild: 'grokbuild:default', codex: 'codex:default', antigravity: 'antigravity:default' };
for (const [engine, model] of Object.entries(engines)) {
  check(`engine ${engine}: block in the prompt only when on`, agentLib.cliSystemPrompt({ model, preferFractions: true }, engine).includes(MARK) && !agentLib.cliSystemPrompt({ model }, engine).includes(MARK));
}
for (const model of ['openai:gpt-5.6', 'gemini:gemini-3-pro', 'ollama:llama3']) {
  check(`engine ${model}: block on every model that takes Lumen's prompt`, agentLib.systemFor({ model, preferFractions: true }).includes(MARK));
}
const src = read('src/ai/agent.js');
check('engines: every path builds its prompt with systemFor (API, Claude Code, Grok Build, Antigravity, Codex, local)',
  // ([engine parity] the sidebar CLIs go through cliSystemFor, which is systemFor plus the skills list)
  (src.match(/systemFor\(/g) || []).length >= 6 && /const cliSystemFor = \(settings\) => systemFor\(settings\) \+/.test(src) && /cliSystemFor\(settings\) \+ claudeCodeNote/.test(src) && /cliSystemFor\(settings\) \+ grokBuildNote/.test(src) && /cliSystemFor\(settings\) \+ antigravityNote/.test(src) && /cliSystemFor\(settings\) \+ codexNote/.test(src) && /systemFor\(messages\.settings\)/.test(src) && /cliSystemPrompt = |function cliSystemPrompt/.test(src));
const req = agentLib.requestFor({ model: 'claude-opus-5', preferFractions: true }, [{ role: 'user', content: 'hi' }]);
check('API request: the system text carries it', JSON.stringify(req.system).includes('Fractions: exact values'));

// ---- budgets: the Grok Build prompt with the switch on (same limits as test/acceptance/chat-prompt-budget.js)
const budgetSrc = read('test/acceptance/chat-prompt-budget.js');
const BUDGET = { system: Number(/const BUDGET = \{ system: (\d+), total: (\d+) \}/.exec(budgetSrc)[1]), total: Number(/const BUDGET = \{ system: (\d+), total: (\d+) \}/.exec(budgetSrc)[2]) };
const listed = agentLib.EXTERNAL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
const tools = JSON.stringify(listed).length;
const withSwitch = agentLib.cliSystemPrompt({ model: 'grokbuild:default', adhdMode: true, preferFractions: true }, 'grokbuild').length;
check(`budget: Grok Build system prompt with the switch on within ${BUDGET.system} (${withSwitch})`, withSwitch <= BUDGET.system, String(withSwitch));
check(`budget: Grok Build prompt + tools with the switch on within ${BUDGET.total} (${withSwitch + tools})`, withSwitch + tools <= BUDGET.total, String(withSwitch + tools));

// ---- the converter
const conv = (s) => {
  const maths = [];
  const out = md.fractionize(s, maths);
  return out.replace(/\uE000(\d+)\uE001/g, (_m, n) => `{${maths[n].tex.split(B).join('')}}`);
};
const same = (label, s) => check(`converter: ${label} stays`, conv(s) === s, conv(s));
const becomes = (label, s, want) => check(`converter: ${label}`, conv(s) === want, conv(s));
becomes('3/4 in a sentence', 'It is 3/4 of it.', 'It is {frac{3}{4}} of it.');
becomes('16/3 at the end of a sentence', 'So the ratio is 16/3.', 'So the ratio is {frac{16}{3}}.');
becomes('negative -5/2', 'x = -5/2, y = 3', 'x = {-frac{5}{2}}, y = 3');
becomes('a real minus sign (−)', 'x = \u22125/2', 'x = {-frac{5}{2}}');
becomes('in parentheses and a list', '- (4/3)\n- 8/3', '- ({frac{4}{3}})\n- {frac{8}{3}}');
becomes('in a table cell', '| d | ratio |\n|---|---|\n| 1 | 4/3 |', '| d | ratio |\n|---|---|\n| 1 | {frac{4}{3}} |');
becomes('the user example', '(2.340 / 2.026)² = 1.334, so 4/3, 8/3 and 16/3', '(2.340 / 2.026)² = 1.334, so {frac{4}{3}}, {frac{8}{3}} and {frac{16}{3}}');
becomes('5/16 (not a date: 16 is not a day a month can have here)', 'a 5/16 inch bolt', 'a {frac{5}{16}} inch bolt');
same('a date 10/19', 'Due 10/19 at noon');
same('a date 10/19/2026', 'Due 10/19/2026');
same('a year-first date 2026/10/19', 'On 2026/10/19');
same('km/h', 'at 60 km/h');
same('and/or', 'this and/or that');
same('24/7', 'open 24/7');
same('50/50', 'a 50/50 chance');
same('a web address', 'see https://example.com/a/3/4 now');
same('a bare path', 'in /usr/3/4/bin and C:\\x\\3/4');
same('a link', '[v 3/4](https://x.test/3/4)');
same('inline code', 'run `a = 3/4` first');
same('a fenced block', 'text\n```py\nx = 3/4\n```\nmore');
same('a tilde fence', '~~~\n3/4\n~~~');
same('a decimal over something', 'it is 2.5/3');
same('a version or ratio with letters', 'v3/4x and 3/4th');
same('a count after "page"', 'on page 3/10');
same('a count after "Step"', 'Step 2/5 done');
same('inside a longer number chain', '1/2/3');
same('a subtraction before it', 'a-3/4');
same('divide by zero', '1/0');
becomes('after a code block it works again', '```\n3/4\n```\nthen 3/4', '```\n3/4\n```\nthen {frac{3}{4}}');
becomes('two on one line, one in code', '`1/2` and 1/2', '`1/2` and {frac{1}{2}}');
// algebraic fractions with a bracketed side (a Laplace answer the model wrote inline)
becomes('a number over a bracket: 2/(s−1)', 'Y = 2/(s−1) + 1', 'Y = {frac{2}{s-1}} + 1');
becomes('a term over a product of brackets, with a square', '6s/((s−1)(s²+1))', '{frac{6s}{(s-1)(s^{2}+1)}}');
becomes('a bracket over a bracket, minus signs kept', '= 3/(s−1) + (−3s + 3)/(s²+1)', '= {frac{3}{s-1}} + {frac{-3s + 3}{s^{2}+1}}');
becomes('a subtraction between two stays a subtraction', 'Y = 5/(s−1) − 3s/(s²+1)', 'Y = {frac{5}{s-1}} − {frac{3s}{s^{2}+1}}');
becomes('a bracket over a term', '(x+1)/x', '{frac{x+1}{x}}');
same('words with a slash', 'and/or, w/o, km/h');
same('a path with a bracket', 'path a/b/(c)');
same('in code', '`2/(s-1)`');
same('a date beside a bracket', 'on 10/19 (Monday)');
check('prompt: names algebraic fractions too', on.includes(`algebra too: $${B}frac{2}{s-1}$`));
// existing math is untouched (liftMath ran first): its token is protected
const rendered = md.render('Is $x = 3/4$ and 5/6?', { fractions: true });
check('render: math the model wrote is not converted twice, the plain one is', (rendered.match(/data-tex="[^"]*"/g) || []).length >= 1 && /frac\{5\}\{6\}/.test(rendered) && /3\/4/.test(rendered), rendered);
check('render: off (no option, no setting) leaves 3/4 as text', !/frac/.test(md.render('about 3/4')) && /3\/4/.test(md.render('about 3/4')));
check('render: copying keeps the LaTeX (the typeset fallback names it)', /data-tex="[^"]*frac\{3\}\{4\}/.test(md.render('about 3/4', { fractions: true })));

// ---- the chat command and the page
const cmds = read('src/renderer/chat-commands.js');
check('/fractions: registered, takes on|off, reserved against skills', /name: 'fractions'/.test(cmds) && /word !== 'on' && word !== 'off'/.test(cmds) && /'usage', 'fractions', 'model'/.test(read('src/features/skills.js')));
check('/fractions: the IPC is served and allowed on the sidebar and the chat page', /ipcMain\.handle\('agent:prefer-fractions'/.test(read('src/main.js')) && /'agent:prefer-fractions', \/\/ \[prefer fractions\]/.test(read('src/main.js')) && /'agent:prefer-fractions'/.test(read('src/features/chat-page.js')) && /agent:prefer-fractions/.test(read('src/preload/preload.js')) && /agent:prefer-fractions/.test(read('src/features/chat-preload.js')));
check('page: ui-prefs.js keeps window.lumenPreferFractions for markdown.js', /window\.lumenPreferFractions = p\.preferFractions === true/.test(read('src/renderer/ui-prefs.js')));
const en = JSON.parse(read('src/locales/en.json'));
check('strings: setting and /fractions texts exist', ['settings.ai.preferFractions', 'settings.ai.preferFractionsDesc', 'slash.fractions', 'slash.fractions.on', 'slash.fractions.off', 'slash.fractions.usage'].every((k) => en[k]));
const docs = read('docs/settings.md');
check('docs: a settings row and a changelog entry', /Prefer fractions/.test(docs) && /aiPreferFractions/.test(docs) && /Prefer fractions/.test(read('CHANGELOG.md'))); // (anywhere: a release cut moves the entry out of Unreleased)

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
