// Site permissions as a page sees them (browser/site-permissions.js, preload/permissions-preload.js), in a real Lumen
// with a throwaway profile and local pages:
//   before any decision: Notification.permission is 'default' and permissions.query says 'prompt' (geolocation,
//   notifications, camera, microphone, clipboard-read), as in Chrome;
//   after Allow: 'granted' in both APIs (and a PermissionStatus fires 'change'); after Don't Allow: 'denied';
//   decisions are per origin and survive a reload; screen wake lock is granted without a prompt;
//   SpeechRecognition is hidden so sites use their fallback.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PAGE = '<!doctype html><title>permissions</title><body>permissions</body>';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const serve = async () => {
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    return { server, port: server.address().port };
  };
  const a = await serve();
  const b = await serve();
  const ip = `http://127.0.0.1:${a.port}/`; // origin A
  const local = `http://localhost:${a.port}/`; // origin B (same port, other host)
  const other = `http://127.0.0.1:${b.port}/`; // origin C
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-permissions-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const waitFor = async (fn, ms = 8000, step = 100) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; };

  const load = (url) => app.evaluate(async ({ webContents }, u) => {
    const wc = global.__agent.browser.activeTab().webContents;
    for (let n = 0; n < 3; n++) {
      try { await wc.loadURL(u); break; } catch { await new Promise((r) => setTimeout(r, 500)); } // (ERR_ABORTED: the new-tab page was still loading)
    }
    return wc.getURL();
  }, url);
  const page = (code) => app.evaluate(({ webContents }, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c, true), code);
  // What the page reads: Notification.permission and permissions.query for each promptable name.
  const reads = () => page(`(async () => {
    const out = { notification: Notification.permission };
    for (const name of ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read']) {
      try { out[name] = (await navigator.permissions.query({ name })).state; } catch (e) { out[name] = 'error: ' + e.message; }
    }
    return out;
  })()`);
  const same = (got, want) => Object.entries(want).every(([k, v]) => got[k] === v);
  // Answer the permission prompt Lumen shows (1 = Allow, 0 = Don't Allow).
  const answer = async (response) => {
    const id = await waitFor(() => app.evaluate(() => global.__dialogs.currentId()));
    if (!id) return false;
    await app.evaluate((_e, [i, r]) => global.__dialogs.respond({ id: i, response: r }), [id, response]);
    return true;
  };
  const askNotifications = (response) => async () => {
    await page('window.__result = null; Notification.requestPermission().then((r) => { window.__result = r; }); 1');
    const answered = await answer(response);
    const result = await waitFor(() => page('window.__result'));
    return { answered, result };
  };

  await load(ip);

  // ---- before any decision: what Chrome shows
  const before = await reads();
  check("before a decision: Notification.permission is 'default' and every query says 'prompt'",
    same(before, { notification: 'default', geolocation: 'prompt', notifications: 'prompt', camera: 'prompt', microphone: 'prompt', 'clipboard-read': 'prompt' }), JSON.stringify(before));
  check('SpeechRecognition and webkitSpeechRecognition are hidden', await page("typeof window.SpeechRecognition === 'undefined' && typeof window.webkitSpeechRecognition === 'undefined'"), 'still present');
  check('permissions.query still works for other names (and returns a real PermissionStatus)',
    await page("navigator.permissions.query({ name: 'notifications' }).then((s) => s instanceof PermissionStatus && typeof s.addEventListener === 'function')"), 'not a PermissionStatus');
  check('toString of the patched functions looks native', await page("/\\[native code\\]/.test(String(Notification.requestPermission)) && /\\[native code\\]/.test(String(Permissions.prototype.query))"), 'shows source');

  // ---- wake lock: no prompt
  const wake = await page(`navigator.wakeLock.request('screen').then((l) => { const r = l.type + ':' + l.released; l.release(); return r; }, (e) => e.name + ': ' + e.message)`);
  check('screen wake lock is granted without a prompt', wake === 'screen:false' || /NotAllowedError: .*(visible|document)/i.test(String(wake)), wake);
  check('no prompt was raised for it', (await app.evaluate(() => global.__dialogs.currentId())) == null, 'a dialog is open');

  // ---- a status made before the decision hears about it
  await page(`window.__changes = []; navigator.permissions.query({ name: 'notifications' }).then((s) => { window.__status = s; s.onchange = () => window.__changes.push(s.state); }); 1`);

  // ---- Allow
  const allow = await askNotifications(1)();
  check("Notification.requestPermission() resolves 'granted' after Allow", allow.answered && allow.result === 'granted', JSON.stringify(allow));
  const afterAllow = await waitFor(async () => { const r = await reads(); return r.notification === 'granted' && r.notifications === 'granted' ? r : null; });
  check("after Allow: Notification.permission and permissions.query both say 'granted'", Boolean(afterAllow), JSON.stringify(await reads()));
  check('after Allow: the other permissions are still undecided', await reads().then((r) => same(r, { geolocation: 'prompt', camera: 'prompt', 'clipboard-read': 'prompt' })), 'changed');
  check("a PermissionStatus made earlier fired 'change' with 'granted'", await waitFor(() => page("window.__changes.includes('granted') && window.__status.state === 'granted'")), JSON.stringify(await page('window.__changes')));
  check('the decision is stored once, under the origin without a trailing slash', await app.evaluate((_e, o) => [...global.__settings.permissions].filter(([k]) => k.endsWith('|notifications')).map(([k, v]) => k === `${o}|notifications` && v === true).join() === 'true', ip.replace(/\/$/, '')), 'wrong key');

  // ---- survives a reload; other origins are untouched
  await load(ip);
  check("after a reload the page still reads 'granted'", await reads().then((r) => r.notification === 'granted' && r.notifications === 'granted'), JSON.stringify(await reads()));
  await load(local);
  const isolatedHost = await reads();
  check("another host (same port) still reads 'default' / 'prompt'", same(isolatedHost, { notification: 'default', notifications: 'prompt', geolocation: 'prompt' }), JSON.stringify(isolatedHost));
  await load(other);
  const isolatedPort = await reads();
  check("another port still reads 'default' / 'prompt'", same(isolatedPort, { notification: 'default', notifications: 'prompt' }), JSON.stringify(isolatedPort));

  // ---- Deny, on its own origin
  await load(local);
  await page(`window.__changes = []; navigator.permissions.query({ name: 'notifications' }).then((s) => { window.__status = s; s.onchange = () => window.__changes.push(s.state); }); 1`);
  const deny = await askNotifications(0)();
  check("Notification.requestPermission() resolves 'denied' after Don't Allow", deny.answered && deny.result === 'denied', JSON.stringify(deny));
  const afterDeny = await reads();
  check("after Don't Allow: Notification.permission and permissions.query both say 'denied'", afterDeny.notification === 'denied' && afterDeny.notifications === 'denied', JSON.stringify(afterDeny));
  check("a PermissionStatus made earlier fired 'change' with 'denied'", await waitFor(() => page("window.__changes.includes('denied')")), JSON.stringify(await page('window.__changes')));
  await load(ip);
  check('the first origin is still granted', await reads().then((r) => r.notification === 'granted' && r.notifications === 'granted'), JSON.stringify(await reads()));

  // ---- geolocation: the same rules through a different API (Allow here; the position itself may not be available)
  await load(other);
  await page('window.__geo = null; navigator.geolocation.getCurrentPosition(() => { window.__geo = "position"; }, (e) => { window.__geo = "error " + e.code; }); 1');
  check('geolocation: the prompt appears and Allow is accepted', await answer(1), 'no prompt');
  const geo = await waitFor(async () => (await reads()).geolocation === 'granted');
  check("geolocation: permissions.query reads 'granted' after Allow", Boolean(geo), JSON.stringify(await reads()));
  check('geolocation: not refused as a permission error (code 1)', await waitFor(() => page('window.__geo')).then((g) => g !== 'error 1'), await page('window.__geo'));

  await app.close().catch(() => {});
  a.server.close();
  b.server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still in use */ }
  console.log(failures ? `\n${failures} permission check(s) FAILED` : '\nAll permission checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
