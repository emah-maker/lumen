// Scores the local organizer against every labelled session: test/fixtures/organize-eval.js (this round's
// set) and test/topics-sessions.js (the older one). Pairwise precision / recall / F1, tabs wrongly grouped
// that should stay loose, and group names that match. Pure Node.
//   node scripts/eval-organize.js [--verbose]
const run = require('../test/topics-sessions-run');
const { sessions } = require('../test/fixtures/organize-eval');
const mod = require('../src/browser/tab-groups');
const verbose = process.argv.includes('--verbose');
let n = 0;
const sum = { f1: 0, precision: 0, recall: 0, wrong: 0, named: 0, labelled: 0 };
for (const s of sessions) {
  if (verbose) console.log(s.name);
  const r = run.runSession(mod, s, verbose);
  console.log(`${s.name.padEnd(52)} P/R/F1 ${r.precision.toFixed(2)}/${r.recall.toFixed(2)}/${r.f1.toFixed(2)}  loose-wrong ${r.wronglyGroupedLoose}  groups ${r.total}/${r.labelled}  named ${r.named}`);
  n++; sum.f1 += r.f1; sum.precision += r.precision; sum.recall += r.recall; sum.wrong += r.wronglyGroupedLoose; sum.named += r.named; sum.labelled += r.labelled;
}
console.log(`EVAL SET  P/R/F1 ${(sum.precision / n).toFixed(2)}/${(sum.recall / n).toFixed(2)}/${(sum.f1 / n).toFixed(2)}  loose-wrong ${sum.wrong}  names right ${sum.named}/${sum.labelled}`);
console.log('--- older sessions (test/topics-sessions.js)');
run.main(mod, false);
