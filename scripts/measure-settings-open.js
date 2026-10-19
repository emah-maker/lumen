// node scripts/measure-settings-open.js [section ...]: prints how long Settings takes to open (cold and warm) on a seeded profile.
const { seedProfile, measure, tmpProfile } = require('../test/_settings-open-rig');
(async () => {
  const profile = tmpProfile();
  await seedProfile(profile);
  for (const section of process.argv.length > 2 ? process.argv.slice(2) : ['']) {
    const r = await measure(profile, section, { intent: section === '' });
    for (const k of ['cold', 'warm']) {
      const m = r[k];
      console.log(`${(section || '(default)').padEnd(10)} ${k.padEnd(4)} paint ${m.paint} filled ${m.filled} input ${m.input} (latency ${m.inputLatency}) ready ${m.ready} | main max ${m.mainMax} over20 ${JSON.stringify(m.mainOver)} | longtasks ${JSON.stringify(m.longtasks)} loaf ${JSON.stringify(m.loafs)} placeholders ${m.placeholders}
   origin ${m.origin} opened ${m.opened} vis ${m.vis} (${m.vis0}) raf1 ${m.raf1} marks ${JSON.stringify(m.marks)}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
