// Scores the AI refine step of Organize offline-first: for a few eval sessions it sends the exact refine request (organize-ai.js REFINE_PROMPT +
// REFINE_SCHEMA + the wire the app builds) to Claude Code's Haiku (the signed-in `claude`), applies the answer the way the app does, and scores
// local-only against local+AI with the same pairwise P/R/F1 as scripts/eval-organize.js.
// Every answer is cached in test/fixtures/organize-ai-cache.json under a hash of (prompt, schema, wire), so re-scoring an unchanged prompt makes no
// call at all, and a run that would need a call without --live stops instead of spending one.
//   node scripts/eval-organize-ai.js                 score from the cache only (no calls)
//   node scripts/eval-organize-ai.js --live          make the missing calls (a few cents of Haiku in all)
//   node scripts/eval-organize-ai.js --prompt v1     score the previous prompt (kept below) instead of the current one
//   node scripts/eval-organize-ai.js --max 12        refuse to make more than 12 live calls in one run (default 12)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bench = require('../test/topics-bench');
const tg = require('../src/browser/tab-groups');
const oai = require('../src/features/organize-ai');
const cliJson = require('../src/ai/cli-json');
const { sessions } = require('../test/fixtures/organize-eval');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const LIVE = process.argv.includes('--live');
const MAX_CALLS = Number(arg('max', 12));
const CACHE_FILE = path.join(__dirname, '..', 'test', 'fixtures', 'organize-ai-cache.json');
// The sessions where the local pass leaves the most to refine (loose tabs, vague names), by name.
const PICK = ['student', 'developer', 'researcher', 'mixed languages', 'buying a home', 'bare and generic', 'long session (~60'];

// The prompt as it was before round 2 (src/features/organize-ai.js at PR #215), for comparison.
const PROMPT_V1 = oai.REFINE_PROMPT_V1;
const prompt = arg('prompt', 'current') === 'v1' ? PROMPT_V1 : oai.REFINE_PROMPT;
const model = arg('model', 'haiku');

const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
const save = () => fs.writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 1)}\n`);
const keyOf = (wire) => crypto.createHash('sha1').update(JSON.stringify([model, prompt, oai.REFINE_SCHEMA, wire])).digest('hex').slice(0, 20);
let live = 0;
let cached = 0;

async function ask(wire) {
  const user = JSON.stringify(wire);
  const key = keyOf(wire);
  if (cache[key]) { cached++; return cache[key].answer; }
  if (!LIVE) throw new Error('not cached (run with --live to make the call)');
  if (live >= MAX_CALLS) throw new Error(`call budget of ${MAX_CALLS} used`);
  live++;
  const bin = await require('../src/ai/claude-code').findClaude();
  const t0 = Date.now();
  const answer = await cliJson.completeJSON({ engine: 'claudecode', bin, model, system: prompt, user, schema: oai.REFINE_SCHEMA, userData: '', timeoutMs: 240000 });
  cache[key] = { model, ms: Date.now() - t0, answer };
  save();
  return answer;
}

async function runSession(s, withAi) {
  const h = bench.harness(tg, { withText: s.tabs.some((t) => t.text) });
  const added = s.tabs.map((t) => h.addTab(t));
  const labelOf = (id) => s.tabs[added.findIndex((t) => t.id === id)].group;
  const stats = await oai.organizeProgressive({ tabGroups: h.tg, ask: withAi ? ask : undefined, cache: oai.createRefineCache(), timeoutMs: 250000 });
  const r = bench.score(h.tabs(), labelOf);
  let named = 0;
  const groups = h.tg.state();
  for (const g of groups) {
    const counts = {};
    for (const t of h.tabs().filter((x) => x.groupId === g.id)) counts[labelOf(t.id)] = (counts[labelOf(t.id)] || 0) + 1;
    const [label] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (s.names[label]?.test(g.name)) named++;
  }
  return { ...r, named, groups: groups.length, stats, names: groups.map((g) => g.name) };
}

async function main({ quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const picked = PICK.map((p) => sessions.find((s) => s.name.includes(p))).filter(Boolean);
  const sum = { local: { p: 0, r: 0, f: 0, named: 0, wrong: 0 }, ai: { p: 0, r: 0, f: 0, named: 0, wrong: 0 } };
  log(`prompt ${arg('prompt', 'current')} (${prompt.length} chars), model ${model}`);
  for (const s of picked) {
    const local = await runSession(s, false);
    let ai;
    try { ai = await runSession(s, true); } catch (err) { log(`${s.name}: ${err.message}`); process.exitCode = 1; continue; }
    const line = (r) => `P/R/F1 ${r.precision.toFixed(2)}/${r.recall.toFixed(2)}/${r.f1.toFixed(2)} named ${r.named}/${r.groups} wrong-loose ${r.wronglyGroupedLoose}`;
    log(`${s.name}\n  local     ${line(local)}\n  local+AI  ${line(ai)}  [${ai.stats.reason}${ai.stats.failed ? `: ${ai.stats.failed}` : ''}; renamed ${ai.stats.renamed} placed ${ai.stats.placed} created ${ai.stats.created} merged ${ai.stats.merged}]`);
    if (process.argv.includes('--verbose')) log(`  names: ${ai.names.join(' | ')}`);
    for (const [k, r] of [['local', local], ['ai', ai]]) { sum[k].p += r.precision; sum[k].r += r.recall; sum[k].f += r.f1; sum[k].named += r.named; sum[k].wrong += r.wronglyGroupedLoose; }
  }
  const n = picked.length;
  for (const k of ['local', 'ai']) log(`${k === 'ai' ? 'local+AI' : 'local   '} average over ${n}: P/R/F1 ${(sum[k].p / n).toFixed(2)}/${(sum[k].r / n).toFixed(2)}/${(sum[k].f / n).toFixed(2)}  names right ${sum[k].named}  wrong-loose ${sum[k].wrong}`);
  log(`live calls this run: ${live}, from cache: ${cached}`);
  return { n, sum, failed: process.exitCode === 1 };
}
module.exports = { main, PICK };
if (require.main === module) main();
