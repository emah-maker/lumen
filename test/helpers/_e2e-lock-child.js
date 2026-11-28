// A second process for test/units/e2e-lock-units.js and release-tooling-units.js: holds the e2e lock or the release reservation, and answers
// one-line commands on stdin with one line on stdout. LUMEN_E2E_LOCK_DIR comes from the parent.
//   node _e2e-lock-child.js hold <owner>              takes the lock, prints "held"; "release" releases it (prints "released")
//   node _e2e-lock-child.js reserve <name>            reserves the machine, prints reserve()'s result ("true");
//        "self"  takes the lock itself (prints "self-ok"), "child" has a child process take it (prints "child-ok" or "blocked"),
//        "free"  unreserves (prints "freed")
//   node _e2e-lock-child.js reserve-and-quit <name>   reserves, then exits with code 3 without unreserving (the exit handler must clean up)
// "exit" ends it.
const path = require('path');
const { spawnSync } = require('child_process');

delete process.env.LUMEN_E2E_LOCK_HELD;
delete process.env.LUMEN_E2E_RESERVED;
const LOCK_JS = path.join(__dirname, '..', '..', 'scripts', 'test', 'e2e-lock.js');
const l = require(LOCK_JS);
const [mode, name] = process.argv.slice(2);
const out = (s) => process.stdout.write(`${s}\n`);

if (mode === 'reserve-and-quit') { l.reserve(name); process.exit(3); }

const childTake = `const l=require(${JSON.stringify(LOCK_JS)});l.acquire({owner:'release-suite',waitMs:2000,pollMs:50,onWait:null}).then(()=>{console.log('child-ok');l.release();},()=>console.log('blocked'));`;

(async () => {
  if (mode === 'hold') { await l.acquire({ owner: name, pollMs: 50, onWait: null }); out('held'); }
  else if (mode === 'reserve') out(String(l.reserve(name)));
  let buf = '';
  process.stdin.on('data', async (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const cmd = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (cmd === 'release') { l.release(); out('released'); }
      else if (cmd === 'self') { await l.acquire({ owner: 'release-self', waitMs: 2000, pollMs: 50, onWait: null }); l.release(); out('self-ok'); }
      else if (cmd === 'child') out(spawnSync(process.execPath, ['-e', childTake], { encoding: 'utf8', env: process.env }).stdout.trim());
      else if (cmd === 'free') { l.unreserve(); out('freed'); }
      else if (cmd === 'exit') process.exit(0);
    }
  });
})();
