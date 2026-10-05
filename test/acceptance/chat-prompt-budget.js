// ACCEPTANCE (feature: slim-system-prompt). Run alone: node scripts/test-acceptance.js chat-prompt-budget
//
// What a Grok Build message costs before the user's own words: the system prompt Lumen passes with
// --system-prompt-override (agent.js cliSystemPrompt: systemFor + grokBuildNote) plus Lumen's tool schemas as the MCP
// server lists them (automation/mcp.js tools/list: name, description, inputSchema). Measured with the defaults a new
// chat gets (ADHD mode on, the model Grok picks itself).
//
// Sizes on main when this was written (2026-10-03, v0.5.7, 28 tools):
//   system prompt 7,659 chars (systemFor 6,040 + grokBuildNote 1,619), tool schemas ~9,350 chars, total ~17,000.
// Budgets: about half of that. Expected to FAIL on main.
const { cliSystemPrompt, EXTERNAL_TOOLS } = require('../../src/ai/agent');

// total: half of today's ~17,000. Tool schemas alone are ~9,350 today, so the total can't be met by trimming the
// system prompt only: the tool descriptions have to get shorter too.
const BUDGET = { system: 3800, total: 9800 }; // total raised from 8500 (the last ~480 chars would mean dropping the Grok Build tool list: slower turns), then 9000 -> 9200 for generate_image (~190 chars: every engine can ask for a picture, ai/image-router.js), then 9200 -> 9800 for upload_file (PR #281's new tool: ~400 chars of schema + a ~140-char prompt rule; the description was already trimmed, a file upload can't be described shorter)

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const settings = { model: 'grokbuild:default', adhdMode: true };
const system = cliSystemPrompt(settings, 'grokbuild').length;
const listed = EXTERNAL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
const tools = JSON.stringify(listed).length;
const total = system + tools;
console.log(`Grok Build: system prompt ${system} chars, ${listed.length} tool schemas ${tools} chars, total ${total} chars`);
console.log(`(for reference, Claude Code: system prompt ${cliSystemPrompt({ model: 'claudecode:default', adhdMode: true }, 'claudecode').length} chars, same tools)`);

check(`Grok Build: system prompt + tool schemas within ${BUDGET.total} chars`, total <= BUDGET.total, `${total} chars (${total - BUDGET.total} over)`);
check(`Grok Build: system prompt within ${BUDGET.system} chars`, system <= BUDGET.system, `${system} chars`);
// Slimmer must not mean missing: every tool is still offered, and the prompt still tells Grok it is Grok in Lumen.
check('Grok Build: all 28 of Lumen\'s tools are still listed', listed.length >= 28 && listed.every((t) => t.name && t.description && t.inputSchema), String(listed.length));
const text = cliSystemPrompt(settings, 'grokbuild');
check('Grok Build: the prompt still names Grok and Lumen', /grok/i.test(text) && /lumen/i.test(text));

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
