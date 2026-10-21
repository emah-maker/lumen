// Rapid switching over unloaded, frozen and normal tabs (hidden, fresh profile): how long a click takes to show in the strip, how long
// after the LAST input the final tab is active with its view visible, and how many tabs were woken on the way.
//   node scripts/measure/measure-switch-burst.js [N=20] [GAP=100]      env: HOW=click|key  LUMEN_ROOT=<another checkout>
require('../../test/_tmp-cleanup');
const rig = require('../../test/_tab-switch-rig');
const N = Number(process.argv[2] || 20);
const GAP = Number(process.argv[3] || 100);
(async () => {
  const r = await rig.launchRig({ tabs: 30, chats: 0, bindChats: false, widgets: false });
  try {
    const slept = await rig.sleepSome(r);
    console.log(`${r.ids.length} tabs, ${slept.sleeping.length} unloaded, ${slept.frozen.length} frozen`);
    { const how = "click";
      const b = await rig.burst(r, { n: N, gap: GAP });
      console.log(`${how} x${N} every ${GAP} ms: strip click->active ${b.per.med}/${b.per.p95}/${b.per.max}  view gap ${b.viewGap.med}/${b.viewGap.max}  final on screen ${Math.round(b.finalMs)} ms after the last input (ok ${b.finalOk})  woke ${b.woke} thawed ${b.thawed}  lagMax ${Math.round(b.lagMax)}`);
      console.log(`  per-switch strip ms: ${b.perRaw.map((x) => Math.round(x)).join(' ')}`);
    }
  } finally { await r.close(); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
