// Screenshots of a tab for the AI's screenshot tool (agent.js, snapshot.js), including a tab that is
// not on screen: the AI keeps working in the tab its task started in while the user looks at another
// tab or window, and a hidden view can come back from capturePage() empty. Then the DevTools
// protocol's Page.captureScreenshot draws it instead (the page is painted for the capture, and main.js
// turns background throttling off for the tab while a run works in it).
//
// captureTab(wc, rect?) -> a non-empty NativeImage, or throws. rect is in view pixels, as capturePage takes it.

let nativeImage_ = null;
const nativeImage = () => (nativeImage_ ||= require('electron').nativeImage);

// Page.captureScreenshot's clip is in CSS pixels; a crop in view pixels maps back through the zoom.
function cssClip(rect, zoom) {
  const z = zoom > 0 ? zoom : 1;
  return { x: rect.x / z, y: rect.y / z, width: Math.max(1, rect.width / z), height: Math.max(1, rect.height / z), scale: 1 };
}

// Page.captureScreenshot with a clip lays the page out at the picture's size for the moment of the capture and puts the old size back after. Two in
// flight on one page each saved "the size before", and the later restore put the first one's size back: the page stayed small in its tab's corner.
// So the captures of one page run one after the other.
const chains = new WeakMap(); // wc -> the last capture's promise
function oneAtATime(wc, task) {
  const run = (chains.get(wc) || Promise.resolve()).then(task, task);
  const tail = run.catch(() => {});
  chains.set(wc, tail);
  return run;
}

function viaDevTools(wc, rect) { return oneAtATime(wc, () => viaDevToolsNow(wc, rect)); }
async function viaDevToolsNow(wc, rect) {
  const dbg = wc.debugger;
  let attachedHere = false;
  if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; } // attached already (automation): share it
  try {
    const params = { format: 'png', fromSurface: true };
    if (rect) params.clip = cssClip(rect, wc.getZoomFactor?.() || 1);
    const shot = await dbg.sendCommand('Page.captureScreenshot', params);
    return nativeImage().createFromBuffer(Buffer.from(shot.data, 'base64'));
  } finally {
    if (attachedHere) { try { dbg.detach(); } catch {} }
  }
}

async function captureTab(wc, rect = null) {
  let image = null;
  try { image = rect ? await wc.capturePage(rect) : await wc.capturePage(); } catch {}
  if (image && !image.isEmpty()) return image;
  let fallback = null;
  try { fallback = await viaDevTools(wc, rect); } catch {}
  if (fallback && !fallback.isEmpty()) return fallback;
  throw new Error('Could not take a screenshot of this tab right now. Use read_page or find instead.');
}

// [activity cards] A small JPEG of the tab for the chat's Browser card: the page is scaled and encoded by the browser engine (the DevTools
// protocol's Page.captureScreenshot with a clip scale), so the main process only handles a ~40 KB base64 string, never a full-size bitmap.
// Falls back to captureTab + resize when the protocol call fails. Answers base64 or null; at most about 60 KB.
// Sharp by default: the picture is the card's displayed size (SHOW_CSS px, see step-ui.js CAP) times the display's scale, so a screen at 200% gets
// 680 px, at 150% 510 px, JPEG quality 80. `lowRes` (Graphics on Light, no hardware drawing) keeps the old small picture: `width` px, quality 55.
const SHOW_CSS = 340;
// A frame that is one colour (a hidden view that was not painted, a canvas the protocol could not read, a viewer whose top is a plain bar) is not a
// picture of the page: it is never shown. A JPEG of a plain colour is tiny, so only a small one is decoded and sampled (a grid of pixels).
function isBlankFrame(base64) {
  try {
    if (typeof base64 !== 'string' || base64.length * 0.75 > 9000) return false;
    const image = nativeImage().createFromBuffer(Buffer.from(base64, 'base64'));
    const { width, height } = image.getSize();
    if (!width || !height) return true;
    const bmp = image.toBitmap();
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (let gy = 0; gy < 12; gy++) for (let gx = 0; gx < 20; gx++) {
      const o = ((Math.min(height - 1, Math.floor((gy + 0.5) * height / 12))) * width + Math.min(width - 1, Math.floor((gx + 0.5) * width / 20))) * 4;
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], bmp[o + c]); hi[c] = Math.max(hi[c], bmp[o + c]); }
    }
    return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) <= 10;
  } catch { return false; }
}
const lastRedraw = new WeakMap(); // wc -> when a blank frame was last drawn again (not more than once in 5 s)
// Answers base64, or null; `state.blank` is set when the tab only gave blank frames (even after drawing it again): the card shows its name instead.
async function captureThumb(wc, opts = {}) {
  const state = opts.state || {};
  const first = await viaProtocol(wc, opts);
  if (first && !isBlankFrame(first)) return first;
  const now = Date.now();
  if (now - (lastRedraw.get(wc) || 0) > 5000) { // a hidden view can hand back a black frame: ask it to paint, then take it the other way (the screenshot path)
    lastRedraw.set(wc, now);
    state.small = false; // (the second picture is the page's own pixels)
    try { wc.invalidate?.(); } catch { /* going away */ }
    await new Promise((r) => { const h = setTimeout(r, 80); h.unref?.(); });
    const second = await viaScreenshot(wc, opts);
    if (second && !isBlankFrame(second)) return second;
    if (second || first) state.blank = true;
    return null;
  }
  if (first) state.blank = true;
  return null;
}
function viaProtocol(wc, opts) { return oneAtATime(wc, () => viaProtocolNow(wc, opts)); }
// One frame from the DevTools screencast, scaled to maxWidth x maxHeight by the compositor (a GPU copy at the small size, no layout change and no
// big bitmap on the main process). Answers base64 JPEG, or null (no frame in time, or someone else's screencast runs on this page).
function screencastFrame(wc, { quality, maxWidth, maxHeight, timeoutMs = 600 }) {
  const dbg = wc.debugger;
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { dbg.removeListener('message', onMessage); } catch { /* gone */ }
      dbg.sendCommand('Page.stopScreencast').catch(() => {});
      resolve(data);
    };
    const onMessage = (_event, method, params) => {
      if (method !== 'Page.screencastFrame' || !params) return;
      dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      finish(typeof params.data === 'string' ? params.data : null);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    dbg.on('message', onMessage);
    dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1 }).catch(() => finish(null));
  });
}
// A live stream of frames from the DevTools screencast for the chat's Browser card, at most `fps` a second. The engine sends a frame when the page paints
// and sends no more until it is acknowledged, so the pace is kept by acknowledging late: a frame that comes sooner than 1000/fps after the last one goes
// out when that time has passed (it is always the newest the page drew; none is queued behind it). The base64 JPEG is passed on as it is, never decoded
// here. A page that stands still sends nothing. `onFrame(base64)` per frame; `onEnd()` if the stream ended by itself (debugger detached).
// A view the user cannot see (a tab the AI works in behind the one in front) is not drawn to the screen, and the engine's screencast sends it nothing:
// then, when no frame comes within `firstMs` of starting, the page is polled instead, one Page.captureScreenshot of its top (its own pixels, no layout
// change) after another at the same pace, a frame only when it differs from the last. Answers { stop() } (a frame held back is sent first), or null.
async function streamThumb(wc, { fps = 15, quality = 70, width = 340, onFrame, onEnd = () => {}, firstMs = 350 }) {
  const dbg = wc.debugger;
  let attachedHere = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
  } catch { return null; }
  let w = 1280;
  let h = 800;
  let dpr = 1;
  try {
    const m = (await dbg.sendCommand('Runtime.evaluate', { expression: '[window.innerWidth, window.innerHeight, window.devicePixelRatio]', returnByValue: true }))?.result?.value;
    if (Array.isArray(m)) { w = Math.max(1, Number(m[0]) || w); h = Math.max(1, Number(m[1]) || h); dpr = Math.max(1, Number(m[2]) || 1); }
  } catch { /* the defaults */ }
  const zoom = wc.getZoomFactor?.() || 1;
  const outW = Math.round(width * Math.max(1, dpr / zoom));
  const minGap = 1000 / Math.max(1, fps);
  let ended = false;
  let held = null;
  let timer = null;
  let last = 0;
  let gotFirst = false;
  let pollTimer = null;
  const ack = (sessionId) => { dbg.sendCommand('Page.screencastFrameAck', { sessionId }).catch(() => {}); };
  const release = () => {
    timer = null;
    const f = held;
    held = null;
    if (!f) return;
    last = performance.now();
    if (!ended) { try { onFrame(f.data); } catch { /* the listener's own */ } ack(f.sessionId); }
  };
  const onMessage = (_event, method, params) => {
    if (ended || method !== 'Page.screencastFrame' || !params || typeof params.data !== 'string') return;
    gotFirst = true;
    if (held) ack(held.sessionId); // (never two: the engine waits for each acknowledgement)
    held = params;
    const wait = last + minGap - performance.now();
    if (wait <= 1) { clearTimeout(timer); release(); } else if (!timer) { timer = setTimeout(release, wait); timer.unref?.(); }
  };
  const finish = (flush) => {
    if (ended) return;
    if (flush && held) release();
    ended = true;
    clearTimeout(timer);
    clearTimeout(pollTimer);
    held = null;
    try { dbg.removeListener('message', onMessage); dbg.removeListener('detach', onDetach); } catch { /* gone */ }
    dbg.sendCommand('Page.stopScreencast').catch(() => {});
    if (attachedHere) { try { dbg.detach(); } catch { /* gone */ } }
  };
  const onDetach = () => { if (ended) return; ended = true; clearTimeout(timer); clearTimeout(pollTimer); held = null; try { dbg.removeListener('message', onMessage); } catch { /* gone */ } onEnd(); };
  dbg.on('message', onMessage);
  dbg.on('detach', onDetach);
  try {
    await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality, maxWidth: outW, maxHeight: Math.round(outW * h / w), everyNthFrame: 1 });
  } catch { finish(false); return null; }
  for (let waited = 0; !gotFirst && !ended && waited < firstMs; waited += 25) await new Promise((r) => { const t = setTimeout(r, 25); t.unref?.(); });
  if (!gotFirst && !ended) { // nothing is drawn for this view: poll it
    dbg.removeListener('message', onMessage);
    dbg.sendCommand('Page.stopScreencast').catch(() => {});
    // The whole width of the page, 16:10 from its top, as the screencast shows it: a clip of only its left 800 px showed a wide page's top-left corner,
    // blown up to the card's width (the sidebar and half a list). Scale 1 always: a smaller scale lays the live page out at the clip's size (see viaProtocolNow).
    const cssW = w;
    const cssH = Math.min(h, cssW * 0.625);
    const pollGap = 1000 / Math.min(fps, 8);
    let q = Math.min(quality, 60);
    let lastData = '';
    const poll = async () => {
      if (ended) return;
      const t0 = performance.now();
      try {
        const shot = await oneAtATime(wc, () => dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: q, fromSurface: true, optimizeForSpeed: true, clip: { x: 0, y: 0, width: cssW, height: cssH, scale: 1 } })); // (in the page's queue: a clip taken while another capture is in flight left the page laid out at the clip's size)
        const data = shot && typeof shot.data === 'string' ? shot.data : '';
        if (data.length > 90000) q = Math.max(25, q - 10); else if (data.length < 40000) q = Math.min(Math.min(quality, 60), q + 5); // (about 30-65 KB a frame)
        if (!ended && data && data !== lastData && !(data.length * 0.75 <= 9000 && isBlankFrame(data))) { lastData = data; try { onFrame(data); } catch { /* the listener's own */ } }
      } catch { /* the page is busy or going away: the next one */ }
      if (!ended) { pollTimer = setTimeout(poll, Math.max(0, pollGap - (performance.now() - t0))); pollTimer.unref?.(); }
    };
    poll();
  }
  return { stop: () => finish(true) };
}
async function viaProtocolNow(wc, { lowRes = false, maxBytes = 45000, state = null } = {}) {
  const dbg = wc.debugger;
  let attachedHere = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
    // The picture is taken at the page's own scale: a clip inside the viewport with scale 1 (what `Page.captureScreenshot` does without any emulation),
    // sent as it is. A clip with a scale below 1 makes Chromium lay the page out at the picture's size for the moment of the capture, a visible resize
    // of the live page at every card frame, and two of them at once left the page small in its tab's corner (see oneAtATime). No scaling on the main
    // process either: a resize of a full frame there costs 15-45 ms; the card's <img> shows the bytes at its own size.
    // (A webContents has no getContentSize, that is a window's: the viewport is read from the page.)
    let w = 1280;
    let h = 800;
    let dpr = 1;
    try {
      const m = (await dbg.sendCommand('Runtime.evaluate', { expression: '[window.innerWidth, window.innerHeight, window.devicePixelRatio]', returnByValue: true }))?.result?.value;
      if (Array.isArray(m)) { w = Math.max(1, Number(m[0]) || w); h = Math.max(1, Number(m[1]) || h); dpr = Math.max(1, Number(m[2]) || 1); }
    } catch { /* the defaults */ }
    const cssW = w;
    const cssH = Math.min(h, cssW * 0.625); // the card shows a 16:10 window onto the top of the page
    // The card shows the picture at 340 CSS px wide: the screencast hands over just that many device pixels (lowRes: 420 px). Where it gives nothing
    // (a hidden view that draws no frames), the page's own pixels are taken as below.
    const zoom = wc.getZoomFactor?.() || 1;
    const outW = lowRes ? 420 : Math.round(SHOW_CSS * Math.max(1, dpr / zoom));
    const frame = await screencastFrame(wc, { quality: lowRes ? 55 : 80, maxWidth: outW, maxHeight: Math.round(outW * h / w) });
    if (frame && frame.length * 0.75 <= (lowRes ? Math.max(maxBytes, 90000) : 260000)) { if (state && lowRes) state.small = true; return frame; } // (small: the compositor scaled it to the card's small size)
    maxBytes = lowRes ? Math.max(maxBytes, 90000) : 260000; // (a sharp frame is the page's own pixels: about 60-200 KB, a few per second)
    for (const q of lowRes ? [38, 28, 20] : [66, 52, 40, 30]) {
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: q, fromSurface: true, optimizeForSpeed: true, clip: { x: 0, y: 0, width: cssW, height: cssH, scale: 1 } });
      if (shot && typeof shot.data === 'string' && shot.data.length * 0.75 <= maxBytes) return shot.data;
    }
  } catch { /* try the screenshot path */ } finally {
    if (attachedHere) { try { dbg.detach(); } catch { /* gone */ } }
  }
  return null;
}
async function viaScreenshot(wc, { lowRes = false, width = 420, quality = 55, maxBytes = 45000 } = {}) {
  if (!lowRes) maxBytes = 220000;
  try {
    const image = await captureTab(wc);
    const imgW = image.getSize().width;
    const sized = image.resize({ width: lowRes ? width : Math.min(imgW, Math.round(SHOW_CSS * imgW / Math.max(1, (wc.getContentSize?.() || [imgW])[0]))), quality: 'good' });
    for (const q of lowRes ? [quality, 38, 30] : [80, 66, 50]) { const jpeg = sized.toJPEG(q); if (jpeg.length <= maxBytes) return jpeg.toString('base64'); }
  } catch { /* no picture right now */ }
  return null;
}

// A saved chat keeps one small final frame (≤ 45 KB): a sharp live frame is scaled down once, when the run is stamped.
function shrinkThumb(base64, { width = 420, maxBytes = 45000 } = {}) {
  try {
    if (typeof base64 !== 'string') return null;
    const image = nativeImage().createFromBuffer(Buffer.from(base64, 'base64'));
    if (image.getSize().width <= width && base64.length * 0.75 <= maxBytes) return base64; // (already small)
    const small = image.getSize().width > width ? image.resize({ width, quality: 'good' }) : image;
    for (const q of [55, 40, 30]) { const jpeg = small.toJPEG(q); if (jpeg.length <= maxBytes) return jpeg.toString('base64'); }
  } catch { /* no saved frame */ }
  return null;
}

// ---------- the page-size safety net (kept here: one module less to load at startup) ----------
// A tab's page must always fill the tab area. Chromium can leave a page drawn or laid out smaller than its view (a DevTools screenshot with a clip, taken
// while another capture was in flight, leaves it at the clip's size in the view's top-left corner), and neither the capture paths (features/tab-capture.js
// runs them one at a time) nor the engine always put it right. This is the safety net: for the tab in front it compares what the page lays itself out at
// (window.innerWidth/innerHeight) with the view's bounds, and reads a 2x2 crop of the view's bottom-right corner (a surface drawn smaller than the view
// cannot give one). A page that is wrong gets any device-metrics override cleared and the view's bounds set again, a pixel off and back (a bounds change is
// what makes the engine lay the page out afresh). Every time it acts it is written to <userData>/diagnostics/page-size.jsonl, to learn which path did it.
const COOLDOWN_MS = 4000; // after acting on a view
const MIN_GAP_MS = 1500; // between two reads of the same view
const TOLERANCE = 3; // CSS px (rounding, a scrollbar being drawn)
const lastFix = new WeakMap(); // view -> when it was last acted on
const checked = new WeakMap(); // view -> when it was last read

// Pure: does the page's layout differ from its view's size? sizes in CSS px.
function layoutMismatch(inner, bounds, zoom = 1) {
  if (!Array.isArray(inner) || inner.length < 2 || !(bounds.width > 8) || !(bounds.height > 8)) return false;
  const z = zoom > 0 ? zoom : 1;
  return Math.abs(inner[0] - bounds.width / z) > TOLERANCE || Math.abs(inner[1] - bounds.height / z) > TOLERANCE;
}

async function surfaceSmaller(view) {
  const b = view.getBounds();
  try {
    const image = await view.webContents.capturePage({ x: Math.max(0, b.width - 2), y: Math.max(0, b.height - 2), width: 2, height: 2 });
    return image.isEmpty();
  } catch { return true; } // (a rect outside the drawn surface: refused)
}

// checkPageSize(view, opts) -> a description of what was wrong and put right, or null.
//   opts.shown()     the view is still the tab in front
//   opts.skip()      the page is laid out at another size on purpose (the new-tab page under the sidebar: device emulation of its own)
//   opts.relayout()  lays the views out again (main.js layout())
//   opts.log(entry)  diagnostics
//   opts.force       act whatever the read says is not needed for the layout test (only the cooldown still applies)
async function checkPageSize(view, { shown = () => true, skip = () => false, relayout = () => {}, log = () => {}, source = '', now = Date.now } = {}) {
  try {
    const wc = view?.webContents;
    if (!wc || wc.isDestroyed() || !shown() || skip() || wc.isLoading()) return null;
    const t = now();
    if (t - (lastFix.get(view) || 0) < COOLDOWN_MS || t - (checked.get(view) || 0) < MIN_GAP_MS) return null;
    checked.set(view, t);
    const bounds = view.getBounds();
    let inner = null;
    try { inner = await wc.executeJavaScript('[innerWidth, innerHeight]', false); } catch { return null; }
    const zoom = wc.getZoomFactor?.() || 1;
    const layoutOff = layoutMismatch(inner, bounds, zoom);
    // (a view that is only not drawn right now, a window behind others or a tab that just came back, reads empty once: confirmed after a repaint before the page is relaid out, a resize the page sees)
    let smaller = layoutOff ? false : await surfaceSmaller(view);
    if (smaller) { try { wc.invalidate?.(); } catch { /* going away */ } await new Promise((r) => { const h = setTimeout(r, 120); h.unref?.(); }); smaller = shown() && await surfaceSmaller(view); }
    if (!shown() || (!layoutOff && !smaller)) return null;
    lastFix.set(view, now());
    const dbg = wc.debugger;
    let cleared = false;
    try {
      const had = dbg.isAttached();
      if (!had) dbg.attach('1.3');
      try { await dbg.sendCommand('Emulation.clearDeviceMetricsOverride'); cleared = true; } catch { /* not supported or going away */ }
      if (!had) { try { dbg.detach(); } catch { /* gone */ } }
    } catch { /* another debugger owns it */ }
    const b = view.getBounds();
    view.setBounds({ ...b, width: Math.max(1, b.width - 1) });
    const timer = setTimeout(() => { try { relayout(); } catch { /* going away */ } }, 60);
    timer.unref?.();
    const entry = { at: new Date(t).toISOString(), source, kind: layoutOff ? 'layout' : 'surface', inner, bounds: { width: bounds.width, height: bounds.height }, zoom, cleared };
    try { log(entry); } catch { /* diagnostics are best effort */ }
    return entry;
  } catch { return null; }
}

// The tab's visible area as a JPEG already scaled to maxWidth, drawn and encoded by the browser's own processes: { data (base64), width,
// height }, or null (no debugger, a tab that will not paint: the caller falls back to captureTab). capturePage() hands the main process
// the full-size bitmap; nativeImage.resize() of it then ran 14 to 45 ms on the main thread per screenshot, toJPEG 4 to 13 ms more.
// Here the main process receives only the finished JPEG. One at a time across all pages, with the event loop let through in between, so
// several agents' screenshots do not stack their readback and encode work into one stall; and in the page's own queue (see oneAtATime).
// But a page that does not answer (a heavy page, a script that runs for seconds, an alert()) must not stop the screenshots of every other tab: the
// turn is held only for SLOT_MS, a healthy capture's time, and then the next tab's capture goes on beside the slow one (before, one chat's
// locked-up tab made every other chat's screenshot wait for it, and time out).
const SLOT_MS = 250;
let captureChain = Promise.resolve();
let capturing = 0; // screenshots queued or being taken
const idleWaiters = new Set();
function captureJpeg(wc, opts) {
  capturing++;
  let free;
  const slot = new Promise((resolve) => { free = resolve; }); // the global turn: ends when this capture is done, or after SLOT_MS
  const run = captureChain.then(() => {
    const timer = setTimeout(free, SLOT_MS);
    const taken = oneAtATime(wc, () => captureJpegNow(wc, opts));
    const done = () => { clearTimeout(timer); free(); };
    taken.then(done, done);
    return taken;
  });
  captureChain = slot.then(() => new Promise((resolve) => setImmediate(resolve)));
  run.then(() => {}, () => {}).then(() => new Promise((resolve) => setImmediate(resolve))).then(() => { if (--capturing === 0) for (const done of [...idleWaiters]) done(); });
  return run;
}
// Resolves once no screenshot is being taken, or after maxMs. A screenshot's result lands on the main process as a ~9 ms task; a step of making an
// agent's window (5-6 ms each) that ran just as one landed stacked into a stall of 15 ms and more (test/mcp-perf.js), so those steps wait for a gap.
function whenCaptureIdle(maxMs = 150) {
  if (capturing === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, maxMs);
    function done() { clearTimeout(timer); idleWaiters.delete(done); resolve(); }
    idleWaiters.add(done);
  });
}
// A JPEG's width and height from its frame header (SOF0-SOF15 but DHT/JPG/DAC), read from the base64 without decoding the picture; null if none.
function jpegSize(base64) {
  try {
    const b = Buffer.from(base64, 'base64');
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = b.readUInt16BE(i + 5);
        const width = b.readUInt16BE(i + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  } catch { /* not a JPEG */ }
  return null;
}
async function captureJpegNow(wc, { maxWidth, quality }) {
  const dbg = wc.debugger;
  let attachedHere = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; } // attached already (automation): share it
    const m = await dbg.sendCommand('Page.getLayoutMetrics');
    const v = m.cssVisualViewport;
    if (!(v?.clientWidth > 0 && v?.clientHeight > 0)) return null;
    const scale = Math.min(maxWidth / v.clientWidth, 2); // (never magnified past 2x: a narrow view is not blown up to the full width)
    const width = Math.max(1, Math.round(v.clientWidth * scale));
    const height = Math.max(1, Math.round(v.clientHeight * scale));
    // A page on screen: one frame of the screencast, scaled by the compositor. A clip with a scale below 1 lays the live page out at the picture's size
    // for the moment of the capture (see viaProtocolNow), and on the tab the user looks at that showed as a flash of the page at every AI screenshot.
    // A view that is not drawn sends no frame in time: then the clip, whose relayout nobody sees.
    if (scale < 1) {
      const frame = await screencastFrame(wc, { quality, maxWidth: width, maxHeight: height, timeoutMs: 250 });
      const size = frame ? jpegSize(frame) : null;
      if (size) return { data: frame, ...size };
    }
    const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality, fromSurface: true, optimizeForSpeed: true, clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale } });
    return shot?.data ? { data: shot.data, width, height } : null;
  } catch {
    return null;
  } finally {
    if (attachedHere) { try { dbg.detach(); } catch {} }
  }
}

module.exports = { checkPageSize, captureJpeg, jpegSize, whenCaptureIdle, layoutMismatch, oneAtATime, streamThumb, captureTab, cssClip, captureThumb, shrinkThumb, isBlankFrame };
