// Times the Spotify card's search in the hidden "Play as Lumen" player: the bridge script (features/spotify-bridge.js) runs in the real
// open.spotify.com, signed out, in a throwaway in-memory session, in a window that is never shown (show: false, no focus, no dialogs).
// For each query it prints the time from the command being sent to the first list the card would get, and to the last one (the full list).
//   node scripts/measure-spotify-search.js [--bridge=<path to a spotify-bridge.js>] [--rounds=2] [--json]
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
