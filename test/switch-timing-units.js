// features/switch-timing.js, the opt-in tab-switch recorder (Settings > Advanced > Record tab-switch timings). Plain Node.
//   - off by default, and off means nothing: begin() returns null, no histogram, no metrics call, no timer is made;
//   - on: a record per switch with the timings, the tab's state and the CPU of the GPU and renderer processes;
//   - a ring buffer of the last 200 switches;
//   - the export holds no URL, no title and no site;
//   - the setting is declared (off) and main loads the module only on demand.
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

(async () => {
  const ST = require('../src/features/switch-timing');
  const calls = { monitor: 0, metrics: 0, gpu: 0 };
  const hist = { max: 4e6, enabled: 0, disabled: 0, reset() {}, enable() { this.enabled++; }, disable() { this.disabled++; } };
  const rec = ST.create({
    monitor: () => { calls.monitor++; return hist; },
    metrics: () => { calls.metrics++; return [{ type: 'Browser', pid: 1, cpu: { percentCPUUsage: 3 } }, { type: 'GPU', pid: 2, cpu: { percentCPUUsage: 12.34 } }, { type: 'Tab', pid: 77, cpu: { percentCPUUsage: 8 } }]; },
    gpuStatus: () => { calls.gpu++; return { gpu_compositing: 'enabled', rasterization: 'enabled' }; },
    versions: { lumen: '0.0.0', electron: '1', chrome: '2', platform: 'test', arch: 'x64' },
  });

  // ---- off: nothing
  const timers = [];
  const realSet = global.setTimeout;
  global.setTimeout = (...a) => { timers.push(a); return realSet(...a); };
  check('the recorder is off by default', rec.enabled() === false);
  check('off: begin() records nothing and returns null', rec.begin({ tab: 1, source: 'click' }) === null && rec.count() === 0);
  check('off: no histogram, no metrics call, no GPU query and no timer', calls.monitor === 0 && calls.metrics === 0 && calls.gpu === 0 && timers.length === 0, JSON.stringify(calls));
  global.setTimeout = realSet;

  // ---- on: one switch
  rec.setEnabled(true);
  const h = rec.begin({ source: 'click', inputAt: performance.timeOrigin + performance.now() - 5, tab: 7, page: 'web', state: 'frozen', pid: 77, throttled: true });
  h.reloaded();
  h.visibilityBefore('hidden');
  h.shown();
  h.paint(undefined, 'visible');
  h.strip();
  const out = rec.exportData();
  const s = out.switches[0];
  check('on: a switch is recorded with its kind, state and process', out.switches.length === 1 && s.source === 'click' && s.page === 'web' && s.state === 'frozen' && s.rendererPid === 77 && s.throttledBackground === true && s.reloaded === true && s.visibilityBefore === 'hidden' && s.visibilityAfter === 'visible', JSON.stringify(s));
  check('...with the click -> main -> shown -> paint -> strip times', ['inputToMain', 'mainToShown', 'shownToPaint', 'inputToStrip', 'inputToPaint'].every((k) => Number.isFinite(s.ms?.[k])) && s.ms.inputToMain >= 4, JSON.stringify(s.ms));
  check('...the event-loop stall during it', s.loopLagMaxMs === 4, String(s.loopLagMaxMs));
  check('...and the CPU of the GPU, renderer and browser processes', s.cpuPercent.gpu === 12.3 && s.cpuPercent.renderer === 8 && s.cpuPercent.browser === 3, JSON.stringify(s.cpuPercent));
  check('the GPU feature status is taken once per session', calls.gpu === 1 && out.gpuFeatureStatus.gpu_compositing === 'enabled');
  rec.begin({ source: 'key', tab: 8 }).finish();
  rec.exportData();
  check('...still once after more switches', calls.gpu === 1, String(calls.gpu));
  check('an unknown source or state is stored as "other" / "live"', (() => { const x = rec.begin({ source: 'http://evil.example', state: 'x', page: 'y', tab: 'z' }); const r = x.record; x.finish(); return r.source === 'other' && r.state === 'live' && r.tab === null; })());

  // ---- the ring buffer
  rec.clear();
  for (let i = 0; i < 260; i++) rec.begin({ source: 'click', tab: i, page: 'lumen' }).finish();
  const all = rec.exportData().switches;
  check('the ring buffer keeps the last 200 switches', all.length === 200 && all[0].tab === 60 && all[199].tab === 259, `${all.length} ${all[0]?.tab} ${all[all.length - 1]?.tab}`);

  // ---- the export holds no URL, title or site
  const text = rec.exportJson();
  check('the export is valid JSON in the documented format', JSON.parse(text).format === 'lumen-tab-switch-timings' && JSON.parse(text).version === 1);
  check('the export contains no URL, address, host or title', !/https?:|:\/\/|www\.|\.com|\.org|\.net|title|url|host/i.test(text.replace(/"privacy": "[^"]*"/, '')), text.slice(0, 200));
  check('every field of a record is a number, a boolean, null or one of a few words', all.every((r) => Object.values(r).every((v) => v === null || ['number', 'boolean'].includes(typeof v) || ['click', 'key', 'other', 'web', 'lumen', 'live', 'frozen', 'unloaded', 'placeholder', 'hidden', 'visible'].includes(v) || typeof v === 'object')));

  // ---- turning it off again
  rec.setEnabled(false);
  check('turned off: begin() records nothing again, the old records stay for the export', rec.begin({ tab: 1 }) === null && rec.count() === 200);

  // ---- wiring: the setting is declared off, main loads the module lazily and leaves the switch hot path alone while off
  const root = path.join(__dirname, '..');
  const backend = fs.readFileSync(path.join(root, 'src', 'settings', 'settings-backend.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  check('the setting is off by default', /\n {2}recordSwitchTimings: false,/.test(backend));
  check('main.js loads the recorder through the lazy proxy only', /const switchTiming = lazy\(\(\) => require\('\.\/features\/switch-timing'\)/.test(main) && !/^const .*require\('\.\/features\/switch-timing'\)/m.test(main.replace(/const switchTiming = lazy[^\n]*\n/, '')));
  check('switchTab does recorder work only while the setting is on', /const timing = switchTimingOn \? beginSwitchTiming\(tab, input\) : null;/.test(main));

  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
