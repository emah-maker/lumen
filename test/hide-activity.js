// [hide activity] In a real window (preload/activity-preload.js): with the settings off, an unfocused page says so
// (so the checks below mean something); with "Hide when you leave the tab" on, a page in a background tab
// reads as visible and focused, never hears visibilitychange or the window's blur/focus, and the patched functions
// look native; frames (another origin, and an about:blank one the page makes) answer the same. With "Hide your
// window size" on, the screen is the window's size, at 0,0. Fingerprinting protection: canvas and audio prints
// differ from the real ones, stay the same on one site, differ between sites (a tracker's frame too); GPC, battery,
// WebRTC policy. All four switches ship on, so the suite turns them off first. The rules for links are test/hide-activity-units.js.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = (frame) => `<!doctype html><title>Activity</title><p>page</p>
<script>window.__events=[];for(const t of ['visibilitychange','blur','focus','pagehide-not'])(t==='visibilitychange'?document:window).addEventListener(t,()=>window.__events.push(t));
document.onvisibilitychange=()=>window.__events.push('onvisibilitychange');</script>
${frame ? `<iframe src="${frame}"></iframe>` : ''}`;

(async () => {
  const other = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE('')); }).listen(0);
  const otherUrl = `http://tracker.test:${other.address().port}/frame`;
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE(otherUrl)); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--host-resolver-rules=MAP site-a.test 127.0.0.1, MAP site-b.test 127.0.0.1, MAP tracker.test 127.0.0.1'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } return fn(); };
  const openTab = (url) => app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, url);
  const showTab = (id) => app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id);
  // Code in the page at `url` (its main frame, or its first frame: frame=1).
  const inPage = (url, code, frame = 0) => app.evaluate(async ({ webContents }, [u, c, f]) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === u);
    if (!wc) return 'NO PAGE';
    const target = f ? wc.mainFrame.frames[0] : wc.mainFrame;
    return target ? target.executeJavaScript(c) : 'NO FRAME';
  }, [url, code, frame]);
  const loaded = (url) => waitFor(async () => (await inPage(url, "document.readyState")) === 'complete');

  const setAll = (on) => app.evaluate(async (_e, v) => { for (const k of ['hideTabActivity', 'hideWindowSize', 'fingerprintProtection', 'sendGpc']) await global.__settings.backend.set(k, v); }, on);
  // What a page's prints read: a canvas with text (toDataURL and getImageData), a blank canvas, a rendered sound
  // (getChannelData and copyFromChannel), the battery and GPC.
  const PRINTS = `(async () => {
    const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
    const c = document.createElement('canvas'); c.width = 220; c.height = 40;
    const x = c.getContext('2d'); x.font = '18px Arial'; x.fillStyle = '#f60'; x.fillRect(10, 5, 60, 20); x.fillStyle = '#069'; x.fillText('Lumen fingerprint 😃', 4, 28);
    const data = c.toDataURL(); const again = c.toDataURL();
    const pixels = Array.from(x.getImageData(0, 0, 220, 40).data).join();
    const blank = document.createElement('canvas'); blank.width = 50; blank.height = 50; blank.getContext('2d');
    const ac = new OfflineAudioContext(1, 4410, 44100); const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = 1000;
    const comp = ac.createDynamicsCompressor(); o.connect(comp); comp.connect(ac.destination); o.start(0);
    const buf = await ac.startRendering(); const ch = buf.getChannelData(0); const copy = new Float32Array(ch.length); buf.copyFromChannel(copy, 0);
    let sum = 0; for (let i = 0; i < ch.length; i++) sum += Math.abs(ch[i]);
    const bat = navigator.getBattery ? await navigator.getBattery() : null;
    return JSON.stringify({ canvas: hash(data), stable: data === again, pixels: hash(pixels), blank: hash(blank.toDataURL()), audio: sum.toFixed(12), copySame: copy.every((v, i) => v === ch[i]),
      battery: bat ? [bat.charging, bat.level] : null, adApis: ['browsingTopics' in document, 'joinAdInterestGroup' in navigator, 'runAdAuction' in navigator, 'sharedStorage' in window, 'attributionReporting' in window, 'interestCohort' in document, 'privateToken' in document], gpc: navigator.globalPrivacyControl, native: Function.prototype.toString.call(HTMLCanvasElement.prototype.toDataURL) });
  })()`;
  const prints = async (url, frame = 0) => JSON.parse(await inPage(url, PRINTS, frame));

  try {
    await setAll(false);
    // ---- off: a background tab is hidden
    const offUrl = `${base}/off`;
    const off = await openTab(offUrl);
    await loaded(offUrl);
    await openTab(`${base}/front1`);
    await sleep(800);
    // (Focus is in the page, not its frame, so an unpatched frame says it has none; whether a background tab reads as
    // hidden depends on the window being on screen, so that is only checked with the setting on.)
    await waitFor(async () => (await inPage(offUrl, 'document.title', 1)) === 'Activity');
    check('off: its frame knows it has no focus', (await inPage(offUrl, 'document.hasFocus()', 1)) === false, await inPage(offUrl, 'document.hasFocus()', 1));
    check('off: and its screen is the real one', (await inPage(offUrl, 'screen.width === outerWidth && screenX === 0')) === false, await inPage(offUrl, '[screen.width, outerWidth, screenX].join()'));
    await app.evaluate((_e, id) => global.__agent.browser.closeTab?.(id), off);

    // ---- on
    await app.evaluate(async () => { await global.__settings.backend.set('hideTabActivity', true); await global.__settings.backend.set('hideWindowSize', true); }); // (through Settings' own setter)
    const onUrl = `${base}/on`;
    const on = await openTab(onUrl);
    await loaded(onUrl);
    await waitFor(async () => (await inPage(onUrl, 'document.title', 1)) === 'Activity');
    await openTab(`${base}/front2`);
    await sleep(800);
    const state = JSON.parse(await inPage(onUrl, "JSON.stringify({ hidden: document.hidden, vis: document.visibilityState, wk: document.webkitVisibilityState, focus: document.hasFocus(), events: window.__events })"));
    check('on: a background tab reads as visible', state.hidden === false && state.vis === 'visible' && (state.wk === undefined || state.wk === 'visible'), JSON.stringify(state));
    check('on: and focused', state.focus === true, JSON.stringify(state));
    check('on: it heard no visibilitychange, blur or focus', state.events.length === 0, JSON.stringify(state.events));
    await showTab(on);
    await sleep(500);
    await openTab(`${base}/front3`);
    await sleep(800);
    check('on: switching away and back is silent too', (await inPage(onUrl, 'window.__events.length')) === 0, await inPage(onUrl, 'window.__events.join()'));
    const native = await inPage(onUrl, "[Function.prototype.toString.call(document.hasFocus), Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get), String(Object.getOwnPropertyDescriptor(document, 'hidden'))].join('|')");
    check('on: the patched functions read as native, and nothing is set on document itself', native === 'function hasFocus() { [native code] }|function get hidden() { [native code] }|undefined', native);
    const frame = await inPage(onUrl, "JSON.stringify([document.hidden, document.visibilityState, document.hasFocus(), screen.width === outerWidth])", 1);
    check('on: a frame from another origin reads the same', frame === '[false,"visible",true,true]', frame);
    const blank = await inPage(onUrl, "(() => { const f = document.createElement('iframe'); document.body.append(f); const d = f.contentDocument; return JSON.stringify([d.hidden, d.visibilityState, f.contentWindow.screen.width === outerWidth]); })()");
    check('on: an about:blank frame the page makes reads the same', blank === '[false,"visible",true]', blank);
    const size = JSON.parse(await inPage(onUrl, "JSON.stringify({ sw: screen.width, sh: screen.height, aw: screen.availWidth, ah: screen.availHeight, ow: outerWidth, oh: outerHeight, x: screenX, y: screenY, l: screen.availLeft, t: screen.availTop })"));
    check('on: the screen is the window\'s size, at 0,0', size.sw === size.ow && size.aw === size.ow && size.sh === size.oh && size.ah === size.oh && size.x === 0 && size.y === 0 && size.l === 0 && size.t === 0 && size.ow > 0, JSON.stringify(size));
    const real = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().size);
    check('(the real screen is another size, so the check means something)', real.width !== size.sw || real.height !== size.sh, JSON.stringify(real));

    // ---- fingerprints: off first (the real readings), then on, on two sites with the same tracker frame in each
    {
      const port = server.address().port;
      const pageAt = (host) => `http://${host}:${port}/fp`;
      await setAll(false);
      const realUrl = `${pageAt('site-a.test')}?real`;
      await openTab(realUrl); await loaded(realUrl);
      const real = await prints(realUrl);
      check('fingerprint off: GPC is not in script, the battery is the real one', real.gpc === undefined, JSON.stringify(real));
      await setAll(true);
      const aUrl = pageAt('site-a.test'); const a2Url = `${aUrl}?again`; const bUrl = pageAt('site-b.test');
      await openTab(aUrl); await loaded(aUrl);
      await openTab(a2Url); await loaded(a2Url);
      await openTab(bUrl); await loaded(bUrl);
      const a = await prints(aUrl); const a2 = await prints(a2Url); const b = await prints(bUrl);
      check('on: the canvas print is not the real one', a.canvas !== real.canvas && a.pixels !== real.pixels, `${a.canvas} ${real.canvas}`);
      check('on: and the same every time on one site', a.stable && a.canvas === a2.canvas && a.pixels === a2.pixels && a.audio === a2.audio, JSON.stringify([a, a2]));
      check('on: another site reads another print', a.canvas !== b.canvas && a.pixels !== b.pixels && a.audio !== b.audio, JSON.stringify([a.canvas, b.canvas, a.audio, b.audio]));
      check('on: a blank canvas stays blank (as real)', a.blank === real.blank, `${a.blank} ${real.blank}`);
      check('on: the sound print is changed', a.audio !== real.audio, `${a.audio} ${real.audio}`);
      check('on: by a hair (under a millionth per sample on average)', Math.abs(Number(a.audio) - Number(real.audio)) < 4410 * 1e-6, `${a.audio} ${real.audio}`);
      check('on: copyFromChannel agrees with getChannelData', a.copySame === true, JSON.stringify(a));
      check('on: the battery reads charging and full (or there is no battery API at all, as in Electron)', a.battery === null || JSON.stringify(a.battery) === '[true,1]', JSON.stringify(a.battery));
      check('Privacy Sandbox ad APIs (Topics, ad auctions, shared storage, attribution) are not there', !a.adApis.some(Boolean), JSON.stringify(a.adApis));
      check('on: navigator.globalPrivacyControl is true', a.gpc === true, a.gpc);
      check('on: toDataURL reads as native', a.native === 'function toDataURL() { [native code] }', a.native);
      // The same tracker frame (tracker.test) inside both sites reads two prints: it can't link the visits.
      const inA = await prints(aUrl, 1); const inB = await prints(bUrl, 1);
      check('on: one tracker frame on two sites reads two different prints', inA.canvas !== inB.canvas && inA.canvas !== real.canvas, JSON.stringify([inA.canvas, inB.canvas]));
      const policy = await app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => w.getURL() === u)?.getWebRTCIPHandlingPolicy(), aUrl);
      check('WebRTC offers only the public address', policy === 'default_public_interface_only', policy);
    }

    // ---- off again: the next page is left alone (the DevTools scripts were taken out too)
    await setAll(false);
    const againUrl = `${base}/again`;
    await openTab(againUrl);
    await loaded(againUrl);
    await waitFor(async () => (await inPage(againUrl, 'document.title', 1)) === 'Activity');
    const again = await inPage(againUrl, "JSON.stringify([document.hasFocus(), screen.width === outerWidth])", 1);
    check('off again: a new page and its frames are left alone', again === '[false,false]', again);
  } catch (err) {
    check('ran to the end', false, err.stack);
  } finally {
    await app.close().catch(() => {});
    server.close(); other.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
