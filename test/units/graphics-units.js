// Graphics (settings-backend.js [igpu]): which GPUs count as integrated, and that the choice is made once and never follows power events.
require('../helpers/_tmp-cleanup');
const G = require('../../src/settings/settings-backend').graphics;

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const dev = (vendorId, deviceString, active) => ({ vendorId, deviceString, active });
const intel = (active) => dev(0x8086, 'Intel(R) Arc(TM) 140T GPU (32GB)', active);
const nvidia = (active) => dev(0x10de, 'NVIDIA GeForce RTX 5080 Laptop GPU', active);
const msBasic = dev(0x1414, 'Microsoft Basic Render Driver', false);

// ---- classify
check('the user\'s laptop: Intel Arc 140T active, an RTX 5080 idle: integrated', G.classify([intel(true), nvidia(false), msBasic, dev(0x8086, null, false)]).integrated === true, JSON.stringify(G.classify([intel(true), nvidia(false)])));
check('the hybrid laptop names its discrete card for the Settings hint', G.classify([intel(true), nvidia(false)]).discrete === 'NVIDIA GeForce RTX 5080 Laptop GPU' && G.classify([nvidia(false)]).discrete === null, JSON.stringify(G.classify([intel(true), nvidia(false)])));
check('the same laptop with the RTX active (dGPU mode): not integrated', G.classify([intel(false), nvidia(true), msBasic]).integrated === false, JSON.stringify(G.classify([intel(false), nvidia(true)])));
check('Intel UHD / Iris Xe active: integrated', ['Intel(R) UHD Graphics 620', 'Intel(R) Iris(R) Xe Graphics'].every((n) => G.classify([dev(0x8086, n, true), nvidia(false)]).integrated), 'no');
check('a discrete Intel Arc A770 / B580 active: not integrated (with another GPU present)', ['Intel(R) Arc(TM) A770 Graphics', 'Intel(R) Arc(TM) B580 Graphics'].every((n) => !G.classify([dev(0x8086, n, true), intel(false)]).integrated), 'yes');
check('an AMD APU ("Radeon(TM) Graphics", "Radeon 780M") active: integrated', ['AMD Radeon(TM) Graphics', 'AMD Radeon(TM) 780M Graphics', 'AMD Radeon 760M Graphics'].every((n) => G.classify([dev(0x1002, n, true), nvidia(false)]).integrated), 'no');
check('an AMD RX card active: not integrated (with another GPU present)', !G.classify([dev(0x1002, 'AMD Radeon RX 7900 XTX', true), intel(false)]).integrated, 'yes');
check('only one GPU (even a discrete card): integrated, one budget for display and pages', G.classify([nvidia(false)]).integrated === true && G.classify([nvidia(true), msBasic]).integrated === true, JSON.stringify(G.classify([nvidia(false)])));
check('several GPUs and none reported active: not integrated', G.classify([intel(false), nvidia(false)]).integrated === false, JSON.stringify(G.classify([intel(false), nvidia(false)])));
check('nothing reported, or only the software renderer: not integrated', !G.classify([]).integrated && !G.classify([msBasic]).integrated && !G.classify(undefined).integrated, 'yes');

// ---- the mode: decided from the setting and the detection, nothing else
const changes = [];
let settings = {};
const g = G.create({ app: { getGPUInfo: async () => ({ gpuDevice: [intel(true), nvidia(false)] }) }, readSettings: () => settings, onChange: (i) => changes.push(i.light) });
(async () => {
  check('before detection, Automatic is Full', g.light() === false && g.info().mode === 'auto', JSON.stringify(g.info()));
  await g.detect();
  check('after detection on an integrated GPU, Automatic is Light', g.light() === true && g.info().device.includes('Arc'), JSON.stringify(g.info()));
  settings = { graphicsMode: 'full' }; check('Full effects wins over the detection', g.light() === false, 'light');
  settings = { graphicsMode: 'light' }; check('Light on', g.light() === true, 'full');
  settings = { graphicsMode: 'nonsense' }; check('an unknown value is Automatic', g.info().mode === 'auto' && g.light() === true, JSON.stringify(g.info()));
  settings = {};
  g.refresh();
  const before = JSON.stringify(g.info());
  // power flapping: the module never subscribes to anything and never reads Performance mode
  const whole = require('fs').readFileSync(require.resolve('../../src/settings/settings-backend.js'), 'utf8');
  const src = whole.slice(whole.indexOf('// ---- [igpu]'), whole.indexOf('const graphics = {'));
  check('it never listens to power, battery or speed-limit events and never reads Performance mode', !/powerMonitor|speed-limit|on-battery|thermal|performanceMode|\.on\(/.test(src.replace(/\/\/.*$/gm, '')), 'found');
  check('the answer does not change between calls', JSON.stringify(g.info()) === before, 'changed');
  const nv = G.create({ app: { getGPUInfo: async () => ({ gpuDevice: [intel(false), nvidia(true)] }) }, readSettings: () => ({}) });
  await nv.detect();
  check('a discrete active GPU: Automatic stays Full; Light can still be chosen', nv.light() === false && G.create({ app: {}, readSettings: () => ({ graphicsMode: 'light' }) }).light() === true, JSON.stringify(nv.info()));
  const broken = G.create({ app: { getGPUInfo: async () => { throw new Error('no gpu'); } }, readSettings: () => ({}) });
  await broken.detect();
  check('a GPU query that fails leaves Full effects', broken.light() === false, 'light');
  // ---- software drawing: Automatic is Light plus the software level; Full effects by hand keeps everything
  const sw = [];
  let swSettings = {};
  const gs = G.create({ app: { getGPUInfo: async () => ({ gpuDevice: [nvidia(true), intel(false)] }), getGPUFeatureStatus: () => ({ gpu_compositing: 'disabled_software', rasterization: 'disabled_software' }) }, readSettings: () => swSettings, onChange: (i) => sw.push([i.light, i.software]) });
  check('before detection nothing is software', gs.software() === false && gs.light() === false, JSON.stringify(gs.info()));
  await gs.detect();
  check('software compositing in the feature status: Automatic is Light and the software level, even on a discrete GPU', gs.software() === true && gs.light() === true, JSON.stringify(gs.info()));
  check('the change was announced once, with both flags', JSON.stringify(sw) === '[[true,true]]', JSON.stringify(sw));
  swSettings = { graphicsMode: 'full' }; check('Full effects by hand keeps every effect in software', gs.software() === false && gs.light() === false, JSON.stringify(gs.info()));
  swSettings = { graphicsMode: 'light' }; check('Light chosen by hand in software drawing: the software level too', gs.software() === true && gs.light() === true, JSON.stringify(gs.info()));
  const launch = G.create({ app: {}, readSettings: () => ({}), launchSoftware: true });
  check('hardware acceleration off at launch: software from the first frame', launch.software() === true && launch.light() === true, JSON.stringify(launch.info()));
  const mid = []; const hw = G.create({ app: { getGPUInfo: async () => ({ gpuDevice: [nvidia(true), intel(false)] }), getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled', rasterization: 'enabled' }) }, readSettings: () => ({}), onChange: (i) => mid.push(i.software) });
  await hw.detect();
  check('a healthy hardware GPU: not software', hw.software() === false && hw.light() === false, JSON.stringify(hw.info()));
  hw.markSoftware();
  check('drawing falls to software mid-session (gpu-health): the level follows at once and is announced', hw.software() === true && hw.light() === true && mid[mid.length - 1] === true, JSON.stringify([hw.info(), mid]));
  check('softStatus reads the status words', hw.softStatus({ gpu_compositing: 'disabled_software' }) && hw.softStatus({ gpu_compositing: 'enabled', rasterization: 'disabled_software' }) && !hw.softStatus({ gpu_compositing: 'enabled', rasterization: 'enabled' }) && !hw.softStatus(null), 'no');
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
