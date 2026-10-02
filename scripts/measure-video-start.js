// Measures how long a YouTube watch page takes to start playing, with the ad blocker on or off, in a real Lumen
// window on a throwaway profile (CLAUDE_BROWSER_TEST + temp CLAUDE_BROWSER_PROFILE; LUMEN_TEST_BACKGROUND keeps the
// window off-screen). Signed out, a handful of page loads, no account actions. Needs network.
//   node scripts/measure-video-start.js [--adblock=off] [--loads=5] [--videos=id1,id2,id3] [--json] [--app=<folder>]
// Per load: ms from navigation start to the first video frame, to the first moment the video is playing (an ad
// counts), and to the first moment the *content* is playing (no ad showing); plus the blocker's own cost: the time
// the synchronous scriptlet IPC took in main, engine.match time per request, long tasks in the page, and how long
// blocked requests took to fail or be stood in. The first load after launch is "cold", the rest "warm".
const { _electron: electron } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (name, d) => (args.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || d;
const ADBLOCK_OFF = opt('adblock', 'on') === 'off';
const LOADS = Number(opt('loads', '5'));
const VIDEOS = opt('videos', 'dQw4w9WgXcQ,9bZkp7q19f0,kJQP7kiw5Fk').split(',');
const IPC = opt('ipc', 'all'); // diagnosis: all | none (no scriptlets) | nofallback (lists' scriptlets only) | fallback (the YouTube fallback only)
const MATCH = opt('match', 'on'); // diagnosis: off = the engine never blocks a request
const COSMETIC = opt('cosmetic', 'all'); // diagnosis: all | nomo (no DOM mutation observer) | none (no cosmetic CSS at all)
const HOOKS = opt('hooks', 'all'); // diagnosis: all | nohdr (no onHeadersReceived) | nobefore (no onBeforeRequest) | none
const PROFILE = args.includes('--profile'); // diagnosis: print the page's top CPU consumers on the second load
const ALLOW = opt('allow', ''); // diagnosis: requests whose URL matches this regex are never blocked
const DROP = opt('drop', ''); // diagnosis: drop the scriptlets whose text matches this regex (e.g. editInboundObjectFn|jsonPrune)
const CLEAR = (args.find((a) => a.startsWith('--clear')) || '').slice(8) || (args.includes('--clear') ? 'all' : ''); // diagnosis: forget YouTube's cookies and/or storage before each load (--clear[=cookies|storage])
const AB = args.includes('--ab'); // diagnosis: alternate loads with the blocker's work on / switched off, in one process
const AS_JSON = args.includes('--json');
const APP = path.resolve(opt('app', path.join(__dirname, '..')));

// Injected at document start (CDP): records when the video first shows a frame / plays, and long tasks.
const PROBE = `(() => {
  if (window.__vs || !/youtube\\.com$/.test(location.hostname)) return;
  const m = window.__vs = { frame: 0, playing: 0, content: 0, adFirst: false, long: [], t0: performance.now() };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) m.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  // (long timers the page sets: YouTube holds playback with some when it suspects a blocker)
  if (${process.argv.includes('--timers')}) { const st = window.setTimeout; m.timers = []; window.setTimeout = function (fn, d, ...r) { try { if (d >= 1500 && m.timers.length < 40) m.timers.push([Math.round(performance.now()), d, String(fn).slice(0, 100)]); } catch {} return st.call(this, fn, d, ...r); }; }
  setInterval(() => {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v) return;
    const p = document.getElementById('movie_player');
    const ad = Boolean(p && p.classList.contains('ad-showing'));
    const now = Math.round(performance.now());
    if (!m.frame && v.readyState >= 2 && v.videoWidth > 0) m.frame = now;
    const playing = !v.paused && !v.ended && v.readyState >= 3 && v.currentTime > 0.05;
    if (playing && !m.playing) { m.playing = now; m.adFirst = ad; }
    if (playing && !ad && !m.content && v.duration > 100) m.content = now; // (ads are short; the videos measured are minutes long)
  }, 25);
})()`;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-vs-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ adblock: !ADBLOCK_OFF }));
  const app = await electron.launch({ args: [APP], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const sleep = (ms) => ui.waitForTimeout(ms);
  const log = (...a) => { if (!AS_JSON) console.error(...a); };
  const go = (url) => app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), url);
  const js = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c, true), code).catch((e) => ({ error: String(e.message || e).slice(0, 120) }));

  if (ADBLOCK_OFF) await sleep(12000); // same settling time as the blocker-on runs get
  if (!ADBLOCK_OFF) {
    const start = Date.now();
    while (!(await app.evaluate(() => global.__adblock.ready())) && Date.now() - start < 90000) await sleep(500);
    log('adblock ready:', await app.evaluate(() => global.__adblock.ready()));
    await sleep(8000); // the patched engine is swapped in a few seconds after launch
  }

  // Main-process instrumentation: scriptlet IPC time and engine.match time (only when the blocker is on).
  await app.evaluate(({ ipcMain, session }, { probe, IPC, MATCH, COSMETIC, HOOKS, DROP, ALLOW }) => {
    const stat = global.__vs = { ipc: [], match: [], net: new Map(), blockedNet: [] };
    const ch = 'lumen-adblock:scriptlets';
    const orig = ipcMain.listeners(ch)[0];
    if (orig) {
      ipcMain.removeAllListeners(ch);
      ipcMain.on(ch, (event, url) => { if (global.__vsActive === false) { event.returnValue = []; return; } const t = process.hrtime.bigint(); const fake = { frameId: event.frameId, processId: event.processId, returnValue: null }; orig(fake, url); const out = (fake.returnValue || []).filter((c) => IPC === 'none' ? false : (IPC === 'all' || (IPC === 'fallback') === /ad-showing/.test(c)) && !(DROP && new RegExp(DROP).test(c))); stat.ipc.push([Number(process.hrtime.bigint() - t) / 1e6, String(url).slice(0, 60)]); event.returnValue = out; });
    }
    if (HOOKS === 'nohdr' || HOOKS === 'none') session.defaultSession.webRequest.onHeadersReceived(null);
    if (HOOKS === 'nobefore' || HOOKS === 'none') session.defaultSession.webRequest.onBeforeRequest(null);
    if (COSMETIC !== 'all') {
      ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
      ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', async () => false);
    }
    if (COSMETIC === 'none') {
      ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
      ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', async () => undefined);
    }
    // --ab: loads alternate between the blocker working and the same process with its work switched off
    // (no scriptlets, no cosmetic rules, nothing blocked), so both see the same network and machine.
    for (const channel of ['@ghostery/adblocker/inject-cosmetic-filters', '@ghostery/adblocker/is-mutation-observer-enabled']) {
      const inner = ipcMain._invokeHandlers?.get(channel);
      if (!inner) continue;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...a) => (global.__vsActive === false ? undefined : inner(...a)));
    }
    const e = global.__adblockEngine;
    if (e) {
      const m = e.match.bind(e);
      e.match = (r) => { const t = process.hrtime.bigint(); const out = MATCH === 'off' || global.__vsActive === false || (ALLOW && new RegExp(ALLOW).test(r.url)) ? { match: false, redirect: undefined } : m(r); if (out.match || out.redirect) { const u = r.url.replace(/[?#].*/, ''); global.__vsBlocked = global.__vsBlocked || new Map(); global.__vsBlocked.set(u, (global.__vsBlocked.get(u) || 0) + 1); } stat.match.push(Number(process.hrtime.bigint() - t) / 1e6); return out; };
    }
    const wc = global.__agent.browser.activeTab().webContents;
    const dbg = wc.debugger;
    try { dbg.attach('1.3'); } catch { /* already attached */ }
    dbg.sendCommand('Network.enable');
    dbg.sendCommand('Page.enable');
    dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: probe });
    dbg.on('message', (_ev, method, p) => {
      if (method === 'Network.requestWillBeSent') { if (!stat.net.has(p.requestId)) stat.net.set(p.requestId, { t: p.timestamp, url: p.request.url, type: p.type }); else if (p.redirectResponse && !stat.net.get(p.requestId).tRedirect) stat.net.get(p.requestId).tRedirect = p.timestamp; }
      else if (method === 'Network.requestWillBeSentExtraInfo') { const r = stat.net.get(p.requestId); if (r && /\/watch\?v=/.test(r.url)) { const h = p.headers || {}; r.hint = h['Sec-CH-Prefers-Color-Scheme'] || h['sec-ch-prefers-color-scheme'] || 'none'; } }
      else if (method === 'Network.loadingFinished') {
        const r = stat.net.get(p.requestId); if (r) { r.end = p.timestamp; r.size = p.encodedDataLength; }
        if (r && /\/watch\?v=/.test(r.url) && !r.themeChecked) { r.themeChecked = true; dbg.sendCommand('Network.getResponseBody', { requestId: p.requestId }).then((b) => { const m = /<html[^>]*>/.exec(b.body || ''); stat.watchDocs = (stat.watchDocs || []); stat.watchDocs.push(`${r.url.slice(-24)} hint=${r.hint} html=${m ? m[0].replace(/\s+(?=\w+=)/g, ' ').slice(0, 160) : '?'}`); }).catch(() => {}); }
      }
      else if (method === 'Network.loadingFailed') { const r = stat.net.get(p.requestId); if (r) r.err = p.errorText + (p.blockedReason ? '/' + p.blockedReason : ''); if (r) stat.blockedNet.push({ url: r.url.slice(0, 90), type: r.type, ms: (p.timestamp - r.t) * 1000, err: p.errorText }); }
      else if (method === 'Network.responseReceived') { const r = stat.net.get(p.requestId); if (r && /^lumen-res:/.test(p.response.url)) stat.blockedNet.push({ url: r.url.slice(0, 90), type: r.type, ms: (p.timestamp - r.t) * 1000, err: 'stand-in', hookMs: r.tRedirect ? (r.tRedirect - r.t) * 1000 : null, handlerMs: r.tRedirect ? (p.timestamp - r.tRedirect) * 1000 : null }); }
    });
  }, { probe: PROBE, IPC, MATCH, COSMETIC, HOOKS, DROP, ALLOW });

  const rows = [];
  for (let i = 0; i < LOADS; i++) {
    const FIRST_NEUTRAL = args.includes('--first-neutral'); // diagnosis: only the very first load runs with the blocker's work off
    const ALL_NEUTRAL = args.includes('--all-neutral'); // diagnosis: every load with the blocker's work off (same process and instrumentation)
    const active = ALL_NEUTRAL ? false : FIRST_NEUTRAL ? i > 0 : (!AB || i % 2 === 0);
    if (AB || FIRST_NEUTRAL || ALL_NEUTRAL) await app.evaluate((_e, a) => { global.__vsActive = a; }, active);
    const vid = VIDEOS[(AB ? i >> 1 : i) % VIDEOS.length];
    if (i > 0) { await go('https://example.com/'); await sleep(800); }
    // diagnosis: forget YouTube's cookies and storage before each load (is the slowness state YouTube keeps about us?)
    if (CLEAR) {
      await app.evaluate(async ({ session }, what) => {
        const ses = session.defaultSession;
        if (what !== 'cookies') await ses.clearStorageData({ origins: ['https://www.youtube.com', 'https://youtube.com'], storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
        if (what !== 'storage') for (const c of await ses.cookies.get({})) if (/youtube|google/.test(c.domain)) await ses.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path}`, c.name);
      }, CLEAR);
    }
    await app.evaluate(() => { global.__vs.ipc = []; global.__vs.watchDocs = []; global.__vs.match = []; global.__vs.net = new Map(); global.__vs.blockedNet = []; });
    if (PROFILE && i === 1) await app.evaluate(async () => { const d = global.__agent.browser.activeTab().webContents.debugger; await d.sendCommand('Profiler.enable'); await d.sendCommand('Profiler.setSamplingInterval', { interval: 500 }); await d.sendCommand('Profiler.start'); });
    const t0 = Date.now();
    await go(`https://www.youtube.com/watch?v=${vid}`);
    const tNav = Date.now() - t0;
    // Wait until content plays (or 30 s). No play() nudge: this is what the user sees.
    let m = null;
    for (let k = 0; k < 120; k++) {
      await sleep(250);
      m = await js('window.__vs ? JSON.parse(JSON.stringify(window.__vs)) : null');
      if (m && m.content) break;
    }
    if (PROFILE && i === 1) {
      const top = await app.evaluate(async () => {
        const d = global.__agent.browser.activeTab().webContents.debugger;
        const { profile } = await d.sendCommand('Profiler.stop');
        const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
        const dt = profile.timeDeltas; let total = 0;
        profile.samples.forEach((id, k) => { const n = byId.get(id); const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^https:\/\/(www\.)?/, '').slice(0, 60)}:${n.callFrame.lineNumber}`; self.set(key, (self.get(key) || 0) + dt[k] / 1000); total += dt[k] / 1000; });
        const byUrl = new Map();
        for (const [k, v] of self) { const u = k.replace(/^\S+ /, '').replace(/:\d+$/, ''); byUrl.set(u, (byUrl.get(u) || 0) + v); }
        return { total: Math.round(total), fns: [...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${Math.round(v)}ms ${k}`), urls: [...byUrl].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${Math.round(v)}ms ${k}`) };
      });
      log('PROFILE', JSON.stringify(top, null, 1));
    }
    const stats = await app.evaluate((_e, ALLNET) => ({ docs: global.__vs.watchDocs, ipc: global.__vs.ipc, match: global.__vs.match, blockedNet: global.__vs.blockedNet, milestones: [...global.__vs.net.values()].filter((r) => ALLNET || /youtubei\/v1\/(player|next|browse)|videoplayback|base\.js|\/watch\?v|get_midroll|ptracking|pagead/.test(r.url)).map((r) => [r.url.replace(/^https:\/\/(www\.)?/, '').slice(0, 55), r.t, r.end || 0, r.size || 0, r.err || ''].concat([r.type])) }), args.includes('--allnet'));
    if (args.includes('--timeline')) { const t = (stats.milestones[0] || [0, 0])[1]; for (const [u, a, b, sz, er] of stats.milestones) log(`   ${String(Math.round((a - t) * 1000)).padStart(6)} -> ${b ? String(Math.round((b - t) * 1000)).padStart(6) : '  fail'}  ${sz}  ${er}  ${u}`); }
    if (args.includes('--cookies')) log('   cookies:', await app.evaluate(async ({ session }) => (await session.defaultSession.cookies.get({})).filter((c) => /youtube|google/.test(c.domain)).map((c) => `${c.name}=${String(c.value).slice(0, 14)}`).sort().join(' ')));
    if (args.includes('--theme')) log('   docs:', JSON.stringify(stats.docs));
    const sum = (a) => Math.round(a.reduce((s, x) => s + x, 0) * 10) / 10;
    const row = {
      load: i + 1, kind: i < (AB ? 2 : 1) ? 'cold' : 'warm', blocker: active ? 'on' : 'neutral', video: vid, navCallMs: tNav,
      timers: args.includes('--timers') ? m?.timers : undefined, frameMs: m?.frame || null, playMs: m?.playing || null, adFirst: m?.adFirst, contentMs: m?.content || null,
      longTasks: (m?.long || []).filter((l) => l[0] < 15000).length, longTaskMs: sum((m?.long || []).filter((l) => l[0] < 15000).map((l) => l[1])),
      ipcCalls: stats.ipc.length, ipcMsTotal: sum(stats.ipc.map((x) => x[0])), ipcMsMax: Math.round(Math.max(0, ...stats.ipc.map((x) => x[0])) * 10) / 10,
      matches: stats.match.length, matchMsTotal: sum(stats.match), matchMsMax: Math.round(Math.max(0, ...stats.match) * 10) / 10,
      blockedReqs: stats.blockedNet.length, blockedMsMax: Math.round(Math.max(0, ...stats.blockedNet.map((x) => x.ms))),
      standIns: (() => { const s = stats.blockedNet.filter((x) => x.err === 'stand-in' && x.handlerMs != null); const r1 = (n) => Math.round(n * 10) / 10; return { n: s.length, hookMsMedian: r1(median(s.map((x) => x.hookMs)) || 0), handlerMsMedian: r1(median(s.map((x) => x.handlerMs)) || 0), handlerMsMax: r1(Math.max(0, ...s.map((x) => x.handlerMs))) }; })(),
      slowBlocked: stats.blockedNet.filter((x) => x.ms > 300).map((x) => `${x.type} ${Math.round(x.ms)}ms ${x.err} ${x.url}`).slice(0, 6),
    };
    rows.push(row);
    log(JSON.stringify(row));
  }
  if (AS_JSON) console.log(JSON.stringify(rows, null, 2));
  else {
    const f = (a) => (a.length ? `${Math.round(median(a))} / ${Math.round(Math.max(...a))}` : 'n/a');
    for (const who of ['on', 'neutral']) {
      if (!rows.some((r) => r.blocker === who)) continue;
      const mine = rows.filter((r) => r.blocker === who);
      const col = (k, kind) => mine.filter((r) => (!kind || r.kind === kind) && r[k] != null).map((r) => r[k]);
      const label = ADBLOCK_OFF ? 'OFF' : who === 'neutral' ? 'ON, its work switched off (control)' : 'ON';
      console.log(`adblock ${label}, ${mine.length} loads (median / worst, ms from navigation start)`);
      for (const k of ['frameMs', 'playMs', 'contentMs']) console.log(`${k}: cold ${f(col(k, 'cold'))}  warm ${f(col(k, 'warm'))}  all ${f(col(k))}`);
      console.log(`ipc total ms (median): ${median(col('ipcMsTotal'))}, match total ms (median): ${median(col('matchMsTotal'))}, long-task ms (median): ${median(col('longTaskMs'))}`);
    }
  }
  if (args.includes('--blocked')) {
    const blocked = await app.evaluate(() => [...(global.__vsBlocked || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 40));
    log('blocked or stood in, by URL (all loads):');
    for (const [u, n] of blocked) log(`  ${String(n).padStart(4)}  ${u.slice(0, 110)}`);
  }
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
