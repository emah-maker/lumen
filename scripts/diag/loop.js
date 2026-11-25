// TEMP diagnostic: run each variant many times the way test-units.js spawns suites; count process-exit hangs.
const { spawn } = require('child_process');
const path = require('path');
const variants = (process.env.VARIANTS || 'chunk32,chunk32-exitcode,chunk32-natural,chunk1,readfile,noscan').split(',');
const N = Number(process.env.N) || 40;
const run = (v) => new Promise((resolve) => {
  const t0 = Date.now(); let out = '';
  const c = spawn(process.execPath, [path.join(__dirname, 'scan-variant.js'), v], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  c.stdout.on('data', (d) => { out += d; });
  let doneAt = 0; c.stdout.on('data', () => { if (!doneAt && /DONE/.test(out)) doneAt = Date.now() - t0; });
  const timer = setTimeout(() => { c.kill('SIGKILL'); resolve({ hang: true, doneAt, ms: Date.now() - t0 }); }, 20000);
  c.on('close', () => { clearTimeout(timer); resolve({ hang: false, doneAt, ms: Date.now() - t0 }); });
});
(async () => {
  for (const v of variants) {
    let hangs = 0, slow = 0; const times = [];
    for (let i = 0; i < N; i++) { const r = await run(v); if (r.hang) hangs++; if (r.ms > 3000) slow++; times.push(r.ms); }
    console.log(`RESULT ${v}: ${hangs} hangs, ${slow} slow (>3s) of ${N}; max ${Math.max(...times)} ms; median ${times.sort((a, b) => a - b)[N >> 1]} ms`);
  }
})();
