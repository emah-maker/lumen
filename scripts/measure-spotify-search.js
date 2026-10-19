// Times the Spotify card's search in the hidden "Play as Lumen" player: the bridge script (features/spotify-bridge.js) runs in the real
// open.spotify.com, signed out, in a throwaway in-memory session, in a window that is never shown (show: false, no focus, no dialogs).
// For each query it prints the time from the command being sent to the first list the card would get, and to the last one (the full list).
//   node scripts/measure-spotify-search.js [--bridge=<path to a spotify-bridge.js>] [--rounds=2] [--json]
//   --controls measure the playbar's buttons instead: from a command being sent to the first state the card would hear, and to the first state that shows the change
//   --bridge   measure another version of the script (e.g. one saved from `git show origin/main:src/features/spotify-bridge.js`)
// Needs network. Starts Electron itself with a hard timeout and closes it; it stops only the process it started.
'use strict';
const path = require('path');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const run = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { stdio: 'inherit', timeout: 240000, killSignal: 'SIGKILL', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' } });
  process.exit(run.status === null ? 1 : run.status);
}

const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('mute-audio');

const args = process.argv.slice(2);
const arg = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || d;
const BRIDGE = path.resolve(arg('bridge', path.join(__dirname, '..', 'src', 'features', 'spotify-bridge.js')));
const ROUNDS = Number(arg('rounds', '2'));
const AS_JSON = args.includes('--json');
const CONTROLS = args.includes('--controls');
const QUERIES = ['daft punk', 'radiohead', 'taylor swift', 'miles davis', 'billie eilish', 'the beatles', 'bad bunny', 'pink floyd'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

(async () => {
  await app.whenReady();
  const SPB = require(BRIDGE);
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { partition: `measure-${Date.now()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const ua = win.webContents.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ lumen\/\S+/i, '');
  win.webContents.setUserAgent(ua);
  const js = (code) => win.webContents.executeJavaScript(code);
  const hard = setTimeout(() => { console.error('timeout'); app.exit(2); }, 230000);
  const results = [];
  try {
    await win.loadURL('https://open.spotify.com/');
    await js(`window.__out = []; document.addEventListener('lumen-engine-out', (e) => { try { window.__out.push({ at: performance.now(), d: JSON.parse(e.detail) }); } catch (x) {} });`);
    await js(SPB.BRIDGE_SOURCE);
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !(await js(`window.__out.some((o) => o.d.t === 'state' && o.d.player === true)`))) await sleep(200);
    const ready = await js(`window.__out.some((o) => o.d.t === 'state')`);
    if (!ready) throw new Error('the page never started the bridge');
    if (CONTROLS) {
      // each command: [label, command, the state field that shows it]
      const plan = [['shuffle on', { cmd: 'shuffle', on: true }, 'shuffle'], ['shuffle off', { cmd: 'shuffle', on: false }, 'shuffle'], ['repeat all', { cmd: 'repeat', mode: 'all' }, 'repeat'], ['repeat off', { cmd: 'repeat', mode: 'off' }, 'repeat'], ['volume 0.3', { cmd: 'volume', level: 0.3 }, 'volume'], ['volume 0.8', { cmd: 'volume', level: 0.8 }, 'volume'], ['next', { cmd: 'next' }, null], ['play', { cmd: 'play' }, null]];
      for (let round = 0; round < ROUNDS; round++) {
        for (const [label, cmd, field] of plan) {
          await js(`window.__out = window.__out.filter((o) => o.d.t !== 'state'); window.__before = null; window.__t0 = performance.now(); document.dispatchEvent(new CustomEvent('lumen-engine-in', { detail: ${JSON.stringify(JSON.stringify(cmd))} }));`);
          await sleep(1800);
          const states = await js(`window.__out.filter((o) => o.d.t === 'state').map((o) => ({ ms: Math.round(o.at - window.__t0), shuffle: o.d.shuffle, repeat: o.d.repeat, volume: o.d.volume }))`);
          const firstState = states.length ? states[0].ms : null;
          const changed = field && states.length ? (states.find((x, i) => i > 0 && x[field] !== states[0][field]) || states.find((x) => x[field] === (cmd.on ?? cmd.mode ?? cmd.level))) : null;
          results.push({ label, round, firstState, shows: changed ? changed.ms : null, field, states: states.length });
          if (!AS_JSON) console.log(`${label.padEnd(12)} round ${round}  first state ${String(firstState ?? '-').padStart(5)} ms  shows the change ${String(changed ? changed.ms : '-').padStart(5)} ms  (${states.length} states in 1.8 s)`);
        }
      }
      const fs = results.map((r) => r.firstState).filter((x) => x !== null);
      console.log(AS_JSON ? JSON.stringify({ results }) : `
median command -> first state ${median(fs)} ms (${fs.length}/${results.length})`);
      clearTimeout(hard); win.destroy(); app.exit(0); return;
    }
    let rid = 100;
    for (let round = 0; round < ROUNDS; round++) {
      for (const term of QUERIES) {
        const me = ++rid;
        const sent = await js(`(() => { window.__out = window.__out.filter((o) => o.d.t !== 'list'); window.__t0 = performance.now(); document.dispatchEvent(new CustomEvent('lumen-engine-in', { detail: ${JSON.stringify(JSON.stringify({ cmd: 'search', term, rid: me }))} })); return true; })()`);
        let lists = [];
        const begun = Date.now();
        let lastCount = 0, lastChange = Date.now();
        while (Date.now() - begun < 16000) {
          await sleep(25);
          lists = await js(`window.__out.filter((o) => o.d.t === 'list' && o.d.kind === 'search' && o.d.rid === ${me}).map((o) => ({ ms: Math.round(o.at - window.__t0), ok: o.d.ok, n: o.d.items.length, songs: o.d.items.filter((i) => i.kind === 'song').length, partial: o.d.partial === true }))`);
          if (lists.length !== lastCount) { lastCount = lists.length; lastChange = Date.now(); }
          if (lists.length && Date.now() - lastChange > 3500) break;
        }
        const good = lists.filter((l) => l.ok && l.n > 0);
        results.push({ term, round, first: good.length ? good[0].ms : null, full: good.length ? good[good.length - 1].ms : null, lists, sent });
        if (!AS_JSON) console.log(`${term.padEnd(14)} round ${round}  first ${String(good[0]?.ms ?? '-').padStart(5)} ms  full ${String(good.at(-1)?.ms ?? '-').padStart(5)} ms  lists ${JSON.stringify(lists.map((l) => `${l.ms}ms:${l.n}/${l.songs}${l.partial ? 'p' : ''}`))}`);
        await sleep(300);
      }
    }
  } catch (err) {
    console.error('measure failed:', err.message);
  }
  clearTimeout(hard);
  const firsts = results.map((r) => r.first).filter((x) => x !== null), fulls = results.map((r) => r.full).filter((x) => x !== null);
  const cold = results.filter((r) => r.round === 0 && r.term === QUERIES[0]).map((r) => r.first);
  const summary = { bridge: path.relative(process.cwd(), BRIDGE), runs: results.length, answered: firsts.length, medianFirstMs: median(firsts), medianFullMs: median(fulls), coldFirstMs: cold[0] ?? null };
  console.log(AS_JSON ? JSON.stringify({ summary, results }) : `\nmedian first ${summary.medianFirstMs} ms, median full ${summary.medianFullMs} ms (${summary.answered}/${summary.runs} answered; first query on a fresh page: ${summary.coldFirstMs} ms)`);
  win.destroy();
  app.exit(0);
})();
