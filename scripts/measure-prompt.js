// Prints the size of every prompt Lumen sends with each AI request: the sidebar's system prompt
// (by section and rule), its tool list (per tool), the CLI engines' system prompts, the background
// task's instructions and the organize prompts. No network, no Electron window, no model calls:
//   node scripts/measure-prompt.js          a table
//   node scripts/measure-prompt.js --json   one JSON object (for comparing two versions)
// Tokens are estimates: "~tok" is chars/4, "wp" a word-piece count (each letter run is a piece per
// 6 letters, each digit run a piece per 3 digits, each other non-space character one piece).
const fs = require('fs');
const path = require('path');
const agent = require('../src/ai/agent');
const bg = require('../src/features/background-agents');
// The Chat Completions tool shape providers.js sends (its toolSchema, not exported).
const toolSchema = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

const { requestFor, cliSystemPrompt, DEFAULT_MODEL, EXTERNAL_TOOLS } = agent;
const wordPieces = (s) => (String(s).match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) || [])
  .reduce((n, t) => n + (/^[A-Za-z]/.test(t) ? Math.ceil(t.length / 6) : /^\d/.test(t) ? Math.ceil(t.length / 3) : 1), 0);
const size = (s) => ({ chars: s.length, tok: Math.round(s.length / 4), wp: wordPieces(s) });

const rows = [];
const add = (group, name, text) => rows.push({ group, name, ...size(typeof text === 'string' ? text : JSON.stringify(text)) });

// ---- sidebar turn on Claude (the default model, ADHD mode on as for a new chat)
const settings = { model: DEFAULT_MODEL, adhdMode: true };
const msgs = Object.assign([{ role: 'user', content: 'hi' }], { settings });
const req = requestFor(settings, msgs);
const system = req.system.map((b) => b.text).join('');
// Sections: blank-line separated blocks; list blocks are split per rule (first words as the name).
for (const block of system.split(/\n\n+/)) {
  const lines = block.split('\n');
  const head = lines[0].endsWith(':') ? lines.shift() : '';
  if (!lines.length || !lines.every((l) => l.startsWith('- '))) { add('system', head || block.slice(0, 48), block); continue; }
  if (head) add('system', head, head);
  for (const l of lines) add('system', `  ${l.slice(2, 50)}`, `${l}\n`);
}
for (const t of req.tools) {
  const { cache_control: _c, ...tool } = t;
  add('tools (Claude)', t.name, tool);
}
const otherSettings = { model: 'openai:gpt-5.4', adhdMode: true };
const otherSystem = agent.systemFor(otherSettings);

// ---- totals per request kind
const totals = [];
const total = (name, parts) => totals.push({ name, ...size(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('')) });
total('sidebar Claude: system', [system]);
total('sidebar Claude: tools', [req.tools]);
total('sidebar Claude: system + tools', [system, req.tools]);
total('sidebar Claude, ADHD off: system', [requestFor({ ...settings, adhdMode: false }, msgs).system[0].text]);
if (otherSystem) total('sidebar OpenAI/xAI/Gemini: system', [otherSystem]);
total('sidebar OpenAI/xAI/Gemini: tools', [toolSchema(EXTERNAL_TOOLS, 'openai')]);
total('Claude Code engine: system', [cliSystemPrompt(settings, 'claudecode')]);
total('Grok Build engine: system', [cliSystemPrompt(settings, 'grokbuild')]);
total('MCP tools for outside agents', [EXTERNAL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))]);
const task = { prompt: 'Check the price of the Kindle Paperwhite and tell me if it is under $120.', allowedSites: ['amazon.com'], schedule: {} };
total('background task: system (API model)', [requestFor({ model: DEFAULT_MODEL, adhdMode: false }, msgs).system[0].text]);
total('background task: instructions (user turn)', [bg.taskPrompt(task, 'task').replace(task.prompt, '')]);
total('background task: CLI system', [cliSystemPrompt({ model: DEFAULT_MODEL, adhdMode: false }, 'claudecode', { background: true })]);
const src = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const quoted = (file, name) => { const m = new RegExp(`const ${name} = '((?:[^'\\\\]|\\\\.)*)'`).exec(src(file)); return m ? m[1] : ''; };
total('organize: ORGANIZE_PROMPT', [quoted('src/main.js', 'ORGANIZE_PROMPT')]);
total('organize: REFINE_PROMPT', [quoted('src/features/organize-ai.js', 'REFINE_PROMPT')]);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, totals }, null, 1));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  let group = '';
  for (const r of rows) {
    if (r.group !== group) { group = r.group; console.log(`\n${group}\n${pad('', 52)}${num('chars', 7)}${num('~tok', 7)}${num('wp', 7)}`); }
    console.log(`${pad(r.name.replace(/\n/g, ' ').slice(0, 50), 52)}${num(r.chars, 7)}${num(r.tok, 7)}${num(r.wp, 7)}`);
  }
  console.log(`\nTotals\n${pad('', 52)}${num('chars', 7)}${num('~tok', 7)}${num('wp', 7)}`);
  for (const t of totals) console.log(`${pad(t.name, 52)}${num(t.chars, 7)}${num(t.tok, 7)}${num(t.wp, 7)}`);
  const marks = JSON.stringify(req).match(/"cache_control"/g)?.length || 0;
  console.log(`\nCache breakpoints on the Claude request: ${marks} (last tool, system, auto on the message tail)`);
}
