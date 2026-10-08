// Auto model routing (features/model-route.js): difficulty scoring, the tier -> model table, a picked
// model never overridden, and follow-ups keeping the previous tier. Plain Node; no Electron, no CLI.
const { score, tierFor, route, TABLE, modelForTier } = require('../src/features/model-route');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const tier = (prompt, o) => tierFor(prompt, o).tier;

// ---- scoring
for (const p of ['hi', 'what time is it in Tokyo', 'summarize this page', 'translate this to French', 'open github.com', 'search for pizza near me']) {
  check(`light: ${p}`, tier(p) === 'light', `${tier(p)} (${score(p)})`);
}
for (const p of ['fix the login bug on this page', 'Write a function that parses CSV', 'Why does this crash?', 'write a SQL query for the monthly totals']) {
  check(`standard: ${p}`, tier(p) === 'standard', `${tier(p)} (${score(p)})`);
}
// Haiku 5.5 takes everyday chat, page questions, summaries and plain browsing (light), not just greetings and lookups.
for (const p of ['find the cheapest flight from Boston to Denver next month on this site', 'what does this page say about refunds?', 'explain how photosynthesis works', 'write a short email declining the invite', 'compare these two laptops and tell me which is better for travel', 'Draft a cover letter for this job posting and keep it under 300 words and friendly']) {
  check(`light (Haiku 5.5): ${p}`, tier(p) === 'light', `${tier(p)} (${score(p)})`);
}
check('code still goes up a tier: Sonnet, not Haiku', route({ engine: 'claudecode', picked: 'default', prompt: 'fix the login bug on this page' }).model === 'sonnet' && route({ engine: 'claudecode', picked: 'default', prompt: 'what does this page say about refunds?' }).model === 'haiku');
check('a code fence is never light', tier('what is this\n```js\nx\n```') !== 'light');
const heavyBrief = [
  'Refactor the checkout flow across the codebase and debug why the cart total is wrong after a coupon is applied.',
  '1. Investigate the root cause in cart.js and pricing.js',
  '2. Design a fix that handles concurrent updates',
  '3. Write tests, then migrate the old orders',
  '4. Also make sure the API docs stay accurate',
].join('\n');
check('heavy: multi-step refactor/debug brief', tier(heavyBrief) === 'heavy', `${tier(heavyBrief)} (${score(heavyBrief)})`);
check('heavy: stack trace + code block', tier('Why does this crash?\n```js\nfoo.bar()\n```\nTypeError: x\n    at run (app.js:10:5)\n    at main (app.js:20:1)') === 'heavy', String(score('x')));
check('attached tabs raise the score', score('compare these', { tabCount: 4 }) > score('compare these'));
check('a light word inside a long brief does not make it light', tier(`${'Please analyze the architecture and design of this system in depth. '.repeat(8)} then open the docs`) === 'heavy');

// ---- mapping table
check('claudecode table: haiku / sonnet / opus', modelForTier('claudecode', 'light') === 'haiku' && modelForTier('claudecode', 'standard') === 'sonnet' && modelForTier('claudecode', 'heavy') === 'opus');
check('table uses CLI aliases, not dated ids', Object.values(TABLE.claudecode).every((m) => /^[a-z]+$/.test(m)));
check('grokbuild has no tiers', modelForTier('grokbuild', 'heavy') === null);

// ---- route(): unspecified vs explicit
const r = route({ engine: 'claudecode', picked: 'default', prompt: heavyBrief });
check('default model is routed', r.auto && r.model === 'opus' && r.label === 'Auto · Opus', JSON.stringify(r));
check('light prompt routes to haiku', route({ engine: 'claudecode', picked: 'default', prompt: 'hi' }).model === 'haiku');
for (const picked of ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-4-1']) {
  const x = route({ engine: 'claudecode', picked, prompt: 'hi' });
  check(`explicit ${picked} is never overridden`, !x.auto && x.model === picked, JSON.stringify(x));
}
check('disabled: default stays default', (() => { const x = route({ engine: 'claudecode', picked: 'default', prompt: heavyBrief, enabled: false }); return !x.auto && x.model === 'default'; })());
check('engine without tiers: default stays default', (() => { const x = route({ engine: 'grokbuild', picked: 'default', prompt: heavyBrief }); return !x.auto && x.model === 'default'; })());

// ---- follow-up hysteresis
const prev = { tier: 'heavy', turns: 1 };
for (const p of ['continue', 'fix it', 'yes', 'ok', 'try again', 'and the tests?', 'do that too']) {
  check(`follow-up "${p}" keeps heavy`, tier(p, { previous: prev }) === 'heavy', tier(p, { previous: prev }));
}
check('no previous turn: "continue" is scored alone', tier('continue', { previous: { tier: 'heavy', turns: 0 } }) !== 'heavy');
check('a new long light task after a hard one is scored on its own', tier('what time is it in Tokyo and what is the weather there right now, please', { previous: prev }) === 'light');
check('a follow-up can still go up', tier(heavyBrief, { previous: { tier: 'light', turns: 2 } }) === 'heavy');
check('standard follow-up keeps standard over light', tier('yes', { previous: { tier: 'standard', turns: 3 } }) === 'standard');
check('route() carries the tier through follow-ups', route({ engine: 'claudecode', picked: 'default', prompt: 'continue', previous: prev }).model === 'opus');

if (failures) { console.log(`\n${failures} model-route check(s) failed`); process.exit(1); }
console.log('\nAll model-route checks passed');
