// node scripts/measure/profile-settings-open.js <outdir>: CPU profiles of the Settings page (renderer) and the main process during a cold open.
const { _electron: electron } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const { seedProfile, tmpProfile, env, root, sleep } = require('../../test/helpers/_settings-open-rig');
(async () => {
  const out = process.argv[2] || '.'; fs.mkdirSync(out, { recursive: true });
  const profile = tmpProfile(); await seedProfile(profile);
  const app = await electron.launch({ args: [root], env: env(profile) });
  try {
    await (await app.firstWindow()).waitForSelector('.tab'); await sleep(3000);
    await app.evaluate(({ app: a }) => {
      const inspector = process.mainModule.require('inspector');
      global.__mainSession = new inspector.Session(); global.__mainSession.connect();
      global.__mainSession.post('Profiler.enable'); global.__mainSession.post('Profiler.setSamplingInterval', { interval: 200 }); global.__mainSession.post('Profiler.start');
      const id = global.__settings.open('');
      const wc = global.__settings.contents(id); global.__rdbg = wc.debugger; wc.debugger.attach('1.3');
      wc.debugger.sendCommand('Profiler.enable').then(() => wc.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 200 })).then(() => wc.debugger.sendCommand('Profiler.start'));
    });
    await sleep(4000);
    const r = await app.evaluate(async () => {
      const main = await new Promise((res) => global.__mainSession.post('Profiler.stop', (e, p) => res(p.profile)));
      let rend = null; try { rend = (await global.__rdbg.sendCommand('Profiler.stop')).profile; } catch {}
      return { main, rend, err: global.__rerr, dbg: Boolean(global.__rdbg) };
    });
    fs.writeFileSync(path.join(out, 'main.cpuprofile'), JSON.stringify(r.main)); if (r.rend) fs.writeFileSync(path.join(out, 'renderer.cpuprofile'), JSON.stringify(r.rend));
    console.log(r.err, r.dbg, 'written', out, Boolean(r.rend));
  } finally { await app.close().catch(() => {}); }
})().catch((e) => { console.error(e); process.exit(1); });
