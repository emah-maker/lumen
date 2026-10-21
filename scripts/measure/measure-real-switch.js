/* global document, PointerEvent */
// Real tab-switch timings on THIS computer: a VISIBLE Lumen window, with real GPU compositing and Windows process scheduling, which the hidden
// test windows never exercise. Run it by hand, when you are not using the computer. It is not part of any test run and nothing starts it for you.
//
//   node scripts/measure/measure-real-switch.js --visible [--idle=90] [--tabs=12] [--rounds=6]
//
// It refuses to start without --visible, because it opens a window on your screen, takes the foreground, and clicks around in it for a few
// minutes. It uses a fresh profile and a private TEMP (never your real profile), and local pages only (no network).
//
// What it does: opens `tabs` local pages (some heavy), visits each, then for each of two arms leaves the app alone for `idle` seconds (a real pause:
// Windows parks the renderers of hidden tabs) and switches to tabs, recording each switch with Settings > Advanced > Diagnostics > "Record tab-switch timings":
//   A  "parked":  Keep the latest tabs ready = 0, and nothing hovers: the way Lumen behaved before.
//   B  "ready":   Keep the latest tabs ready = 3 (the default): switches to the latest 3 tabs, with no hover.
//   C  "hover":   ready = 0, but the pointer rests on the tab 150 ms before the click (a real hover, then the click).
// It prints, per arm, the time from the click to the tab's first frame (median / p95 / max, ms), the renderer's priority just before the switch
// (idle = Windows had parked it) and how many setVisible calls a switch made, then writes the full export next to where you ran it.
// Read it like this: if A's first-frame time is clearly higher than B's and C's, the parked renderer was the lag, and the default fixes it;
// if all three are alike, the lag is somewhere else (the export's "gpuFeatureStatus" and "byIdleBefore" say where to look next).
require('../../test/_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const rig = require('../../test/_tab-switch-rig');

const arg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
if (!process.argv.includes('--visible')) {
  console.error('This opens a VISIBLE Lumen window and takes the foreground for a few minutes.\nRun it yourself when you are not using the computer:\n  node scripts/measure/measure-real-switch.js --visible [--idle=90] [--tabs=12] [--rounds=6]');
  process.exit(2);
}
const IDLE = arg('idle', 90);
const TABS = arg('tabs', 12);
const ROUNDS = arg('rounds', 6);
const sleep = rig.sleep;

(async () => {
  // LUMEN_TEST_BACKGROUND empty: the window is a normal visible one (the rest of the test harness gives the script its hooks).
  const r = await rig.launchRig({ tabs: TABS, chats: 0, widgets: false, extraEnv: { LUMEN_TEST_BACKGROUND: '' } });
  const { app, ui } = r;
  const click = (id) => ui.evaluate((tab) => document.querySelector(`#tabs .tab[data-id="${tab}"]`).click(), id);
  const pointer = (kind, id) => ui.evaluate(({ kind, id }) => document.querySelector(`#tabs .tab[data-id="${id}"]`).dispatchEvent(new PointerEvent(kind, { bubbles: true, pointerType: 'mouse' })), { kind, id });
  const out = {};
  try {
    await app.evaluate(() => { global.__tabReady.enable(true); global.__tabReady.battery(false); global.__settings.backend.set('recordSwitchTimings', true); });
    const visitAll = async () => { for (const id of r.ids) { await click(id); await sleep(400); } };
    for (const arm of ['parked', 'ready', 'hover']) {
      await app.evaluate((_e, v) => global.__settings.backend.set('tabReadyRecent', v), arm === 'ready' ? 3 : 0);
      await visitAll();
      const first = (await app.evaluate(() => global.__switchTiming.data())).switches.length;
      for (let i = 0; i < ROUNDS; i++) {
        // go to a tab, then to another, and leave the app alone: the tab just left is "recent", the ones before it are older
        await click(r.ids[(i * 5 + 1) % r.ids.length]);
        await sleep(500);
        await click(r.ids[(i * 5 + 2) % r.ids.length]);
        console.log(`[${arm}] round ${i + 1}/${ROUNDS}: leaving the app alone for ${IDLE} s ...`);
        await sleep(IDLE * 1000);
        // arm B goes back to the tab just left (a recent one); A and C to the same tab too, so the arms are comparable
        const target = r.ids[(i * 5 + 1) % r.ids.length];
        if (arm === 'hover') { await pointer('pointerover', target); await sleep(150); }
        await click(target);
        await sleep(1200);
        if (arm === 'hover') await ui.evaluate(() => document.querySelector('#tabs').dispatchEvent(new PointerEvent('pointerleave')));
      }
      const data = await app.evaluate(() => global.__switchTiming.data());
      const rows = data.switches.slice(first).filter((s) => s.idleMs >= IDLE * 1000 * 0.8); // (the switches after a pause)
      const stat = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]; return v.length ? `${q(0.5)}/${q(0.95)}/${v[v.length - 1]}` : 'n/a'; };
      out[arm] = { n: rows.length, inputToPaint: stat(rows.map((s) => s.ms?.inputToPaint)), shownToPaint: stat(rows.map((s) => s.ms?.shownToPaint)), priorityBefore: rows.map((s) => s.priorityBeforeLabel), kept: rows.map((s) => s.kept), visibleCalls: rows.map((s) => s.visibleCalls) };
      out.export = data;
    }
    console.log('\nafter a pause of', IDLE, 's (ms: median / p95 / max)');
    for (const arm of ['parked', 'ready', 'hover']) console.log(`  ${arm.padEnd(7)} n=${out[arm].n}  click -> first frame ${out[arm].inputToPaint}   shown -> first frame ${out[arm].shownToPaint}   priority before: ${out[arm].priorityBefore.join(',')}   kept: ${out[arm].kept.join(',')}   setVisible calls: ${out[arm].visibleCalls.join(',')}`);
    const file = path.join(process.cwd(), `lumen-real-switch-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\nfull results: ${file}`);
  } finally {
    await r.close();
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
