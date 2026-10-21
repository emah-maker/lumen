// Top self-time functions (and top inclusive) of a .cpuprofile: node scripts/_top.js file [filterSubstring]
const p = JSON.parse(require('fs').readFileSync(process.argv[2]));
const self = new Map();
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const dt = p.timeDeltas;
p.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + dt[i] / 1000); });
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split(/[\\/]/).slice(-2).join('/')}:${n.callFrame.lineNumber}`;
const selfAgg = new Map();
const incAgg = new Map();
for (const [id, ms] of self) {
  const n = byId.get(id);
  selfAgg.set(key(n), (selfAgg.get(key(n)) || 0) + ms);
  const seen = new Set();
  for (let c = id; c; c = parent.get(c)) { const k = key(byId.get(c)); if (!seen.has(k)) { seen.add(k); incAgg.set(k, (incAgg.get(k) || 0) + ms); } }
}
const show = (m, t) => console.log(`--- ${t}\n` + [...m].filter(([k]) => !/\(idle\)|\(program\)|\(root\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(0).padStart(6)} ${k}`).join('\n'));
if (process.argv[3] === 'stalls') { // contiguous non-idle stretches over 40 ms, with what ran in them
  const minMs = Number(process.argv[4] || 40);
  let run = [], ms = 0;
  const flush = () => {
    if (ms >= minMs) {
      const agg = new Map();
      for (const [id, d] of run) { const k = key(byId.get(id)); agg.set(k, (agg.get(k) || 0) + d); }
      console.log(`stall ${ms.toFixed(0)} ms: ` + [...agg].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${v.toFixed(0)} ${k}`).join(' | '));
    }
    run = []; ms = 0;
  };
  p.samples.forEach((id, i) => { const n = byId.get(id); const idle = /\(idle\)/.test(n.callFrame.functionName); const d = dt[i] / 1000; if (idle) flush(); else { run.push([id, d]); ms += d; } });
  flush();
  process.exit(0);
}
show(selfAgg, 'self');
show(incAgg, 'inclusive');
