// Detailed numbers for switching tabs, on the app built from source, hidden (LUMEN_TEST_BACKGROUND, a fresh profile and a
// private TEMP). Builds a long-lived-looking profile (50 chats, home widgets on, ~30 local pages: plain, heavy DOM, a playing
// video, timers, PDFs in the built-in viewer; four pinned, two groups) and times switches by click and by Ctrl+Tab.
//
//   node scripts/measure/measure-tab-switch.js [N=20]
//   env: TABS=30  CHATS=50  CHATKB=12 (the size of each reply in a seeded chat) CHATSCALE=1 (times the 2 to 12 exchanges each chat has: 8 gives chats of about 1 MB at 8 KB a reply)
//        SIDEBAR=1 (the sidebar open on every tab)  LUMEN_ROOT=<another checkout> (measure the code before a change)  PROFILE=1 (a CPU profile of the main process and of the UI renderer during the switches ->
//        $TEMP/tabswitch-*.cpuprofile; summarise with scripts/measure/cpuprofile-top.js)  IDLE=1 (also CPU when idle)  JSON=1 (last line)
//
// Columns (ms; median / p95 / max): shown = click reaches main -> new view visible; sync = main's click handler's own run time;
// strip = click -> the UI's tab strip shows the tab active; settled = two frames after that (the chat panel and the rest of the UI done);
// lag = main event-loop stall during the switch; long = longest UI long task during the switch.
require('../../test/helpers/_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const rig = require('../../test/helpers/_tab-switch-rig');

const N = Number(process.argv[2] || 20);
const outDir = process.env.OUT || process.cwd(); // (where PROFILE=1 writes: not the run's private TEMP, which is removed at the end)
const fmt = (s) => `${s.med}/${s.p95}/${s.max}`;

async function startProfiles(r) {
  if (!process.env.PROFILE) return null;
  const cdp = await r.ui.context().newCDPSession(r.ui);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await r.app.evaluate(async () => { const { Session } = process.mainModule.require('inspector'); const s = global.__tsp.insp = new Session(); s.connect(); const post = (m, p) => new Promise((res, rej) => s.post(m, p, (e, x) => (e ? rej(e) : res(x)))); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 200 }); await post('Profiler.start'); });
  return cdp;
}
async function stopProfiles(r, cdp, name) {
  if (!cdp) return;
  const ui = await cdp.send('Profiler.stop');
  fs.writeFileSync(path.join(outDir, `tabswitch-${name}-ui.cpuprofile`), JSON.stringify(ui.profile));
  const main = await r.app.evaluate(async () => { const s = global.__tsp.insp; const x = await new Promise((res, rej) => s.post('Profiler.stop', (e, v) => (e ? rej(e) : res(v)))); return JSON.stringify(x.profile); });
  fs.writeFileSync(path.join(outDir, `tabswitch-${name}-main.cpuprofile`), main);
  console.log(`profiles: ${path.join(outDir, `tabswitch-${name}-{main,ui}.cpuprofile`)}`);
}

(async () => {
  const hard = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 25 * 60 * 1000);
  const r = await rig.launchRig({ tabs: Number(process.env.TABS || 30), chats: Number(process.env.CHATS ?? 50), chatKb: Number(process.env.CHATKB || 12), chatScale: Number(process.env.CHATSCALE || 1), sidebar: process.env.SIDEBAR === '1' });
  const result = {};
  try {
    console.log(`${r.ids.length} tabs open, ${process.env.CHATS ?? 50} chats (one per tab), sidebar ${process.env.SIDEBAR === '1' ? 'open' : 'closed'}; ${N} switches per kind (median/p95/max ms)`);
    for (const how of ['click', 'key']) {
      const cdp = await startProfiles(r);
      const { rows, summary, frameMax } = await rig.measureSwitches(r, { n: N, how });
      await stopProfiles(r, cdp, how);
      result[how] = { ...summary, frameMax };
      console.log(`\n${how}: ${summary.bad ? `(${summary.bad} switches did not change the tab) ` : ''}` + ['shown', 'sync', 'strip', 'settled', 'lag', 'long'].map((k) => `${k} ${fmt(summary[k])}`).join('  ') + `  frameMax ${Math.round(frameMax)}`);
      if (process.env.ROWS) console.log(rows.map((x) => JSON.stringify(x)).join('\n'));
    }
    result.typing = await rig.measureTyping(r, 30);
    console.log(`\naddress-bar typing latency (ms): ${fmt(result.typing)}`);
    if (process.env.IDLE) {
      result.idle = await rig.measureIdle(r, 10000);
      console.log('\nidle CPU % by process type (10 s, 30 tabs):', JSON.stringify(result.idle));
    }
    const intervals = await r.app.evaluate(() => global.__perf.intervals());
    result.intervals = intervals.length;
    console.log(`\nsetInterval timers in main: ${intervals.length}`);
    if (r.errors.length) console.log('UI page errors:', r.errors.slice(0, 5));
    if (process.env.JSON) console.log(JSON.stringify(result));
  } finally {
    clearTimeout(hard);
    await r.close();
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
