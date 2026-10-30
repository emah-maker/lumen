// [review loop] The review skill (features/skills.js 'review') and the requests that should load it (reviewIntent). The tool and the card are
// tested in test/e2e/review-loop.js.
const skills = require('../../src/features/skills');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

// ---- the built-in
const b = skills.BUILTINS.find((x) => x.name === 'review');
check('a built-in "review" skill ships', Boolean(b), skills.BUILTINS.map((x) => x.name).join(','));
const r = skills.normalizeSkill({ ...b, id: skills.builtinId('review'), source: 'builtin', createdAt: 0 }, { now: () => 0 });
check('...it is a valid skill', r.ok, r.error);
check('...the AI may use it on its own (named in the system prompt)', r.skill?.autoUse === true);
check('...it works with tools (agent mode)', r.skill?.mode === 'agent');
const text = r.skill?.prompt || '';
check('...a separate reviewer every round, never the worker rereading its own work', /separate reviewer/i.test(text) && /NEW reviewer agent for every round/.test(text) && /never by rereading it yourself/.test(text));
check('...a bar (9/10 when none is named) and a rubric kept for every round', /9\/10 when they named none/.test(text) && /rubric/.test(text) && /same bar and rubric in every round/.test(text));
check('...every round reported with review_round', /call review_round/.test(text));
check('...it stops: at the bar, after 5 rounds, or when it stalls', /after 5 rounds/.test(text) && /less than 0\.5/.test(text));
check('...it works with other engines too (their agents, or Lumen\'s delegate helper)', /Codex/.test(text) && /delegate tool/.test(text));
check('...its name is no chat command of another feature', !skills.RESERVED.has('review'));

// ---- which requests load it
const yes = [
  'Create a separate reviewer agent that rates the slides, keep going until 9/10',
  'make the resume a 9/10',
  'get this to 8.5 / 10',
  'rate my essay out of 10 and fix it',
  'keep improving the essay until it is good',
  'keep polishing the deck until it’s perfect',
  'have a reviewer check the code',
  'rate it until it is right, then fix',
];
const no = [
  'what is the weather in Boston',
  'summarize this page',
  'fix the bug in main.js',
  'Make the slides better',
  'Explain slide 4 of my Quiz 6 slides in one paragraph',
  '/review the deck', // (the skill itself)
  '',
  'how do I review a pull request on GitHub', // (no "reviewer", no score)
];
for (const t of yes) check(`asks for a standard: ${JSON.stringify(t)}`, skills.reviewIntent(t) === true);
for (const t of no) check(`does not: ${JSON.stringify(t)}`, skills.reviewIntent(t) === false);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall review-loop units passed');
process.exit(failures ? 1 : 0);
