/* global document, window */
// Idle wakeups of the new-tab pages and the music card's web player, in a hidden window (LUMEN_TEST_BACKGROUND, throwaway profile, never focused,
// no dialogs). Counts, over --secs seconds after start-up has settled:
//   - renderer timer wakeups/s: every setTimeout/setInterval callback that runs in a new-tab page (a preload patches the page's timers before its
//     scripts run), per page: the resident spare, and the visible new-tab page;
//   - executeJavaScript calls/s on any webContents, and how many of them are the web player's slot probe;
//   - CPU %: app.getAppMetrics() every 5 s, summed over all processes (mean) and for renderers.
//   node scripts/measure-timers.js [--scenario spare|visible|web|all] [--secs 120] [--app <checkout dir>]
//   spare:   a web page is in front; the resident spare new-tab page (hidden) has a world clock with seconds and a music card in its widgets
//   visible: the new-tab page is in front with that clock and a playing music card (the engine's read() is a mock: the song advances, nothing is loaded)
//   web:     the new-tab page is in front with a Spotify Web-player card (a stand-in https page over the slot); counts the placing probe
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const SECS = Number(val('secs', 120));
const APP = path.resolve(val('app', path.join(__dirname, '..')));
const WHICH = val('scenario', 'all');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenarios = WHICH === 'all' ? ['spare', 'visible', 'web'] : WHICH.split(',');
const hardStop = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, (scenarios.length * (SECS + 120) + 60) * 1000);

// Patches the timers of the new-tab page (main world, before its scripts) so wakeups can be counted.
const preload = path.join(os.tmpdir(), 'lumen-timers-preload.js');
fs.writeFileSync(preload, `
const { contextBridge } = require('electron');
if (location.protocol === 'file:' && /[/]newtab[.]html$/.test(location.pathname)) {
  contextBridge.executeInMainWorld({ func: () => {
    const c = (window.__timerStats = { fired: 0, created: 0, by: {} });
    for (const name of ['setTimeout', 'setInterval']) {
      const orig = window[name];
      window[name] = function (fn, ms, ...rest) {
        c.created++;
        if (typeof fn !== 'function') return orig.call(this, fn, ms, ...rest);
        const where = String(new Error().stack.split(String.fromCharCode(10))[2] || '').split(String.fromCharCode(47)).pop().trim() + ' ' + name + ' ' + ms;
        return orig.call(this, function () { c.fired++; c.by[where] = (c.by[where] || 0) + 1; return fn.apply(this, arguments); }, ms, ...rest);
      };
    }
  } });
}
`);
const hook = path.join(os.tmpdir(), 'lumen-timers-hook.js');
fs.writeFileSync(hook, `
const { app } = require('electron');
global.__ejs = { total: 0, probes: 0, paused: false };
app.on('session-created', (ses) => { try { ses.registerPreloadScript({ id: 'measure-timers', type: 'frame', filePath: ${JSON.stringify(preload)} }); } catch (e) { console.error('preload', e); } });
app.on('web-contents-created', (_e, wc) => {
  const proto = Object.getPrototypeOf(wc);
  if (proto.__counted) return;
  proto.__counted = true;
  const orig = proto.executeJavaScript;
  proto.executeJavaScript = function (code) { if (!global.__ejs.paused) { global.__ejs.total++; if (/sp-web-slot/.test(String(code))) global.__ejs.probes++; } return orig.apply(this, arguments); };
});
`);
const entryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-timers-entry-'));
const appPkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(entryDir, 'package.json'), JSON.stringify({ name: appPkg.name, productName: appPkg.productName, version: appPkg.version, main: 'entry.js' }));
fs.writeFileSync(path.join(entryDir, 'entry.js'), `require(${JSON.stringify(hook)}); require('electron').app.setAppPath(${JSON.stringify(APP)}); require(${JSON.stringify(path.join(APP, appPkg.main || 'main.js'))});`);

function standIn() { // a local https server (throwaway certificate) that stands in for open.spotify.com
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-timers-cert-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Stand-in Spotify</title><body>Stand-in</body>'); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `https://127.0.0.1:${srv.address().port}/web` })));
}

const CLOCK = { id: 'wclock001', type: 'worldclock', x: 0, y: 0, w: 4, h: 4, wc: { clock: 'auto', seconds: true, places: [{ name: 'Tokyo, Japan', lat: 35.7, lon: 139.7, tz: 'Asia/Tokyo' }, { name: 'Paris, France', lat: 48.85, lon: 2.35, tz: 'Europe/Paris' }] } };
const MUSIC = { id: 'wmusic001', type: 'spotify', mode: 'status', x: 8, y: 0, w: 4, h: 3 };
const WEB = { id: 'wweb00001', type: 'spotify', mode: 'web', x: 0, y: 0, w: 4, h: 4 };

async function run(scenario) {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Page</title><body><h1>Page</h1></body>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tls = scenario === 'web' ? await standIn() : null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-timers-'));
  const settings = { homeWidgets: scenario === 'web' ? [WEB] : [CLOCK, MUSIC], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false };
  if (scenario === 'spare') settings.session = { urls: [`${base}/`], titles: ['Page'], favicons: [null], active: 0, groupIds: [null], pinned: [false] };
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
  const app = await electron.launch({ args: [entryDir, '--ignore-certificate-errors'], timeout: 60000, env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab', { timeout: 60000 });
    await app.evaluate((_e, a) => {
      if (global.__spareNewTab) global.__spareNewTab.enable(true);
      if (a.tls) { global.__spotifyWebUrl = a.tls; global.__spotifyDrmProbe = async () => true; }
      if (a.mock && global.__spotifyEngine) { // a song that plays on: the engine's read() answers the card, nothing is loaded
        const t0 = Date.now();
        global.__spotifyEngine.read = async () => ({ mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann Marlowe', album: 'Quiet Hours', progressMs: 12000 + (Date.now() - t0), durationMs: 3600000, at: Date.now(), source: 'engine', kind: 'track', reason: '', art: '', device: '', liked: false, shuffle: false, repeat: 'off', volume: 0.6, signedIn: true, engine: 'ready', drm: 'ok', can: { search: true, seek: true, like: true, shuffle: true, repeat: true, volume: true } });
      }
    }, { tls: tls?.url || '', mock: scenario !== 'web' });
    await sleep(12000); // start-up settles (the spare page is made, widgets are fetched and drawn)
    if (scenario !== 'web') await app.evaluate(() => { for (const e of global.__widgets.cache.values()) { e.at = 0; e.retryAt = 0; } return global.__widgets.refreshAll({ force: true }); }).catch(() => {});
    await sleep(3000);
    const read = () => app.evaluate(async ({ webContents }) => {
      const pages = [];
      global.__ejs.paused = true;
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed() || !/newtab\.html/.test(wc.getURL())) continue;
        const r = await wc.executeJavaScript('({ hidden: document.hidden, timers: window.__timerStats ? { ...window.__timerStats, by: { ...window.__timerStats.by } } : null, card: Boolean(document.querySelector(".w-card")), playing: document.querySelector(".sp-elapsed")?.textContent || null, clockText: document.querySelector(".wc-time")?.textContent || null })').catch(() => null);
        pages.push({ id: wc.id, ...r });
      }
      global.__ejs.paused = false;
      return { pages, ejs: { ...global.__ejs } };
    });
    const cpu = [];
    const sample = async () => cpu.push(await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, cpu: m.cpu.percentCPUUsage }))));
    const a = await read();
    await sample();
    const t0 = Date.now();
    while (Date.now() - t0 < SECS * 1000) { await sleep(5000); await sample(); }
    const secs = (Date.now() - t0) / 1000;
    const b = await read();
    const pagesOut = b.pages.map((pb) => {
      const pa = a.pages.find((x) => x.id === pb.id);
      const d = pa?.timers && pb.timers ? pb.timers.fired - pa.timers.fired : null;
      return { id: pb.id, hidden: pb.hidden, card: pb.card, timerWakeups: d, timerWakeupsPerSec: d === null ? null : Number((d / secs).toFixed(3)), timersCreated: pb.timers?.created, firedBy: pb.timers ? Object.fromEntries(Object.entries(pb.timers.by).map(([k, v]) => [k, v - ((pa?.timers?.by || {})[k] || 0)]).filter(([, v]) => v > 0)) : null, playingText: pb.playing, clockText: pb.clockText };
    });
    const flat = cpu.slice(1);
    const sum = (f) => flat.reduce((t, s) => t + s.filter(f).reduce((u, m) => u + m.cpu, 0), 0) / Math.max(1, flat.length);
    const out = {
      scenario, app: APP, secs: Math.round(secs), pages: pagesOut,
      executeJavaScriptPerSec: Number(((b.ejs.total - a.ejs.total) / secs).toFixed(3)),
      webPlayerProbesPerSec: Number(((b.ejs.probes - a.ejs.probes) / secs).toFixed(3)),
      cpuPercentAllProcesses: Number(sum(() => true).toFixed(2)),
      cpuPercentRenderers: Number(sum((m) => m.type === 'Tab').toFixed(2)),
      cpuPercentBrowser: Number(sum((m) => m.type === 'Browser').toFixed(2)),
    };
    console.log(JSON.stringify(out, null, 1));
    return out;
  } finally {
    await Promise.race([app.close().catch(() => {}), sleep(15000)]);
    server.close(); tls?.srv.close();
  }
}

(async () => {
  const all = [];
  for (const s of scenarios) all.push(await run(s));
  console.log('SUMMARY ' + JSON.stringify(all.map((r) => ({ scenario: r.scenario, pages: r.pages.map((p) => ({ hidden: p.hidden, perSec: p.timerWakeupsPerSec, card: p.card })), ejsPerSec: r.executeJavaScriptPerSec, probesPerSec: r.webPlayerProbesPerSec, cpuAll: r.cpuPercentAllProcesses, cpuRenderers: r.cpuPercentRenderers }))));
  clearTimeout(hardStop);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
