// Realistic-session benchmark for automatic "By topic" grouping (tab-groups.js): 8 sessions of 19-28
// tabs (a trip, a course, a product comparison, dev work, news, recipes, job hunting, mixed unrelated
// tabs) from test/fixtures/topic-sessions.json. Titles, URLs and page descriptions only; no network,
// no Electron. Three ways of grouping are scored, all through the real createTabGroups():
//   batch     Organize by topic (every tab there, loose ones clustered once)
//   restore   automatic grouping once over a restored session (titles, descriptions already known)
//   live      automatic grouping after every tab is opened, its description arriving a moment later
// Metrics per session:
//   F1        pairwise precision/recall/F1 of "these two tabs share a group"
//   ARI       adjusted Rand index over all tabs (loose tabs count as singletons)
//   grouped   share of topic tabs that ended up in some group        (goal >= 85%)
//   wrong     share of genuinely unrelated tabs pulled into a group  (goal <= 10%)
//   named     share of groups whose name contains a wanted word (1-3 words, not generic)
//   node test/topics-realistic.js [--verbose] [--json]
const path = require('path');
const bench = require('./topics-bench');
const { sessions } = require('./fixtures/topic-sessions.json') ;

const GENERIC = /^(group|tabs?|pages?|misc|other|stuff|new|home|docs?|links?)$/i;

function comb2(n) { return (n * (n - 1)) / 2; }

// Adjusted Rand index between two labelings (arrays of labels; every loose tab is its own class).
function adjustedRand(truth, pred) {
  const n = truth.length;
  const table = new Map();
  const rows = new Map();
  const cols = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${truth[i]}\u0000${pred[i]}`;
    table.set(key, (table.get(key) || 0) + 1);
    rows.set(truth[i], (rows.get(truth[i]) || 0) + 1);
    cols.set(pred[i], (cols.get(pred[i]) || 0) + 1);
  }
  let sumCells = 0;
  for (const v of table.values()) sumCells += comb2(v);
  let sumRows = 0;
  for (const v of rows.values()) sumRows += comb2(v);
  let sumCols = 0;
  for (const v of cols.values()) sumCols += comb2(v);
  const expected = (sumRows * sumCols) / comb2(n);
  const max = (sumRows + sumCols) / 2;
  return max === expected ? 1 : (sumCells - expected) / (max - expected);
}

function scoreRun(session, tabs, groups) {
  const truthOf = new Map(tabs.map((t, i) => [t.id, session.tabs[i].group]));
  const pair = bench.score(tabs, (id) => truthOf.get(id));
  const truthLabels = tabs.map((t, i) => truthOf.get(t.id) || `~loose${i}`);
  const predLabels = tabs.map((t, i) => (t.groupId != null ? `g${t.groupId}` : `~loose${i}`));
  const topic = tabs.filter((t) => truthOf.get(t.id));
  const unrelated = tabs.filter((t) => !truthOf.get(t.id));
  const grouped = topic.length ? topic.filter((t) => t.groupId != null).length / topic.length : 1;
  const wrong = unrelated.length ? unrelated.filter((t) => t.groupId != null).length / unrelated.length : 0;
  // A group is "right" when its majority label is a real topic; its name is right when it contains a
  // wanted word (session.names[label] is a regex source), has 1-3 words and is not a generic word.
  let named = 0;
  let namable = 0;
  const detail = [];
  for (const g of groups) {
    const members = tabs.filter((t) => t.groupId === g.id);
    const count = {};
    for (const m of members) if (truthOf.get(m.id)) count[truthOf.get(m.id)] = (count[truthOf.get(m.id)] || 0) + 1;
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    const words = g.name.trim().split(/\s+/);
    const ok = Boolean(best) && new RegExp(session.names[best[0]] || best[0], 'i').test(g.name) && words.length <= 3 && !GENERIC.test(g.name.trim());
    namable++;
    if (ok) named++;
    detail.push({ name: g.name, size: members.length, label: best ? best[0] : '(none)', pure: best ? best[1] / members.length : 0, ok });
  }
  const wantedGroups = new Set(session.tabs.map((t) => t.group).filter(Boolean)).size;
  return { f1: pair.f1, precision: pair.precision, recall: pair.recall, ari: adjustedRand(truthLabels, predLabels), grouped, wrong, named: namable ? named / namable : 1, groups: groups.length, wantedGroups, detail };
}

const modes = {
  batch(mod, s) {
    const h = bench.harness(mod, { withText: true });
    const tabs = s.tabs.map((t) => h.addTab(t));
    h.tg.organizeByTopic();
    return { h, tabs };
  },
  restore(mod, s) {
    const h = bench.harness(mod, { withText: true });
    const tabs = s.tabs.map((t) => h.addTab(t));
    h.tg.autoGroup();
    return { h, tabs };
  },
  live(mod, s) {
    const h = bench.harness(mod, { withText: true });
    const tabs = [];
    for (const t of s.tabs) {
      const tab = h.addTab({ ...t, text: '' }); // the title is known first, the description a moment later
      tabs.push(tab);
      h.tg.autoGroup();
      tab.text = t.text || '';
      h.tg.autoGroup();
    }
    return { h, tabs };
  },
};

function evaluate(mod, only = null) {
  const out = {};
  for (const [mode, run] of Object.entries(modes)) {
    if (only && !only.includes(mode)) continue;
    out[mode] = sessions.map((s) => {
      const { h, tabs } = run(mod, s);
      return { name: s.name, ...scoreRun(s, tabs, h.tg.state()) };
    });
  }
  return out;
}

const mean = (rows, key) => rows.reduce((a, r) => a + r[key], 0) / rows.length;
const pct = (x) => `${Math.round(x * 100)}%`.padStart(4);
const num = (x) => x.toFixed(2);

function report(results, { verbose = false } = {}) {
  for (const [mode, rows] of Object.entries(results)) {
    console.log(`\n=== ${mode}`);
    console.log(`${'session'.padEnd(58)} F1    ARI   grouped wrong named groups(want)`);
    for (const r of rows) {
      console.log(`${r.name.padEnd(58)} ${num(r.f1)}  ${num(r.ari).padStart(5)}  ${pct(r.grouped)}    ${pct(r.wrong)}   ${pct(r.named)}   ${r.groups}(${r.wantedGroups})`);
      if (verbose) for (const d of r.detail) console.log(`      ${d.ok ? 'ok ' : 'BAD'} "${d.name}" ${d.size} tabs, ${d.label} ${pct(d.pure)} pure`);
    }
    console.log(`${'AVERAGE'.padEnd(58)} ${num(mean(rows, 'f1'))}  ${num(mean(rows, 'ari')).padStart(5)}  ${pct(mean(rows, 'grouped'))}    ${pct(mean(rows, 'wrong'))}   ${pct(mean(rows, 'named'))}`);
  }
}

module.exports = { evaluate, report, adjustedRand, sessions, mean };

if (require.main === module) {
  const modPath = process.argv.find((a) => a.startsWith('--module='))?.slice(9);
  const mod = require(modPath ? path.resolve(modPath) : '../tab-groups');
  const results = evaluate(mod);
  if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 1));
  else report(results, { verbose: process.argv.includes('--verbose') });
}
