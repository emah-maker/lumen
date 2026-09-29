// Scores the mixed sessions (test/topics-sessions.js): pairwise P/R/F1, wrongly grouped loose
// tabs, and how many labelled groups got a name that matches. Pure Node.
//   node test/topics-sessions-run.js [--verbose]
const bench = require('./topics-bench');
const { sessions } = require('./topics-sessions');

function runSession(mod, s, verbose) {
  const h = bench.harness(mod, { withText: false });
  const added = s.tabs.map((t) => h.addTab(t));
  h.tg.groupLoose();
  const labelOf = (id) => s.tabs[added.findIndex((t) => t.id === id)].group;
  const r = bench.score(h.tabs(), labelOf);
  // A predicted group is "named" when its majority label's regex matches its name.
  let named = 0;
  let total = 0;
  const groups = h.tg.state();
  for (const g of groups) {
    const members = h.tabs().filter((t) => t.groupId === g.id);
    const counts = {};
    for (const m of members) counts[labelOf(m.id)] = (counts[labelOf(m.id)] || 0) + 1;
    const [label] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    total++;
    if (s.names[label]?.test(g.name)) named++;
    if (verbose) console.log(`   ${g.name.padEnd(26)} ${members.map((m) => `${labelOf(m.id) ?? '-'}#${m.id}`).join(' ')}`);
  }
  const labelled = new Set(s.tabs.map((t) => t.group).filter(Boolean)).size;
  return { ...r, named, total, labelled };
}

function main(mod = require('../tab-groups'), verbose = process.argv.includes('--verbose')) {
  const sum = { f1: 0, precision: 0, recall: 0, named: 0, labelled: 0, wrong: 0, groups: 0 };
  for (const s of sessions) {
    if (verbose) console.log(s.name);
    const r = runSession(mod, s, verbose);
    console.log(`${s.name.padEnd(52)} P/R/F1 ${r.precision.toFixed(2)}/${r.recall.toFixed(2)}/${r.f1.toFixed(2)}  loose-wrong ${r.wronglyGroupedLoose}  groups ${r.total}/${r.labelled}  named ${r.named}`);
    sum.f1 += r.f1; sum.precision += r.precision; sum.recall += r.recall; sum.named += r.named; sum.labelled += r.labelled; sum.wrong += r.wronglyGroupedLoose; sum.groups += r.total;
  }
  const n = sessions.length;
  console.log(`AVERAGE  P/R/F1 ${(sum.precision / n).toFixed(2)}/${(sum.recall / n).toFixed(2)}/${(sum.f1 / n).toFixed(2)}  loose-wrong ${sum.wrong}  groups ${sum.groups} (want ${sum.labelled})  names right ${sum.named}/${sum.labelled}`);
  return sum;
}

module.exports = { runSession, main };
if (require.main === module) main();
