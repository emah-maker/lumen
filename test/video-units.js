// video_overview / video_frames, plain Node (no Electron, no window): timestamp parsing and spacing, image-token estimates
// and fitting a contact sheet to a budget, the sheet's pixels, the page scripts run against a fake <video> (state
// restore, DRM / tainted / no video / live), the tools end to end with fake page and image APIs, and the tool lists.
require('./_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const B = require('../src/ai/video-budget');
const S = require('../src/ai/video-sheet');
const V = require('../src/features/video-capture');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// ---- timestamps
check('timestamps: seconds, m:ss, h:mm:ss and decimals parse', B.parseTimestamp(83) === 83 && B.parseTimestamp('83') === 83 && B.parseTimestamp('83.5s') === 83.5 && B.parseTimestamp('1:23') === 83 && B.parseTimestamp('1:02:03') === 3723 && B.parseTimestamp('0:05.5') === 5.5, '');
check('timestamps: junk, negatives and out-of-range minutes are refused', ['abc', '', '1:75', '-3', '1:2:3:4', NaN, -1, null, '12:60'].every((x) => B.parseTimestamp(x) === null), '');
check('timestamps: format as m:ss, h:mm:ss and tenths', B.formatTime(83) === '1:23' && B.formatTime(5) === '0:05' && B.formatTime(3723) === '1:02:03' && B.formatTime(83.57, 1) === '1:23.5' && B.formatTime(-4) === '0:00', B.formatTime(83.57, 1));
const times = B.spacedTimes(0, 160, 16);
check('spacing: 16 frames over 160 s sit at the middle of each 10 s slice, inside the video', times.length === 16 && times[0] === 5 && times[15] === 155 && times.every((t, i) => i === 0 || t - times[i - 1] === 10), JSON.stringify(times));
check('spacing: a window and a single frame', JSON.stringify(B.spacedTimes(60, 120, 2)) === '[75,105]' && B.spacedTimes(0, 10, 1)[0] === 5, '');
check('spacing: never past the end', B.spacedTimes(0, 0.03, 4).every((t) => t >= 0 && t <= 0.03), '');
check('spacing: tenths only when frames are under a second apart', B.decimalsFor(0, 10, 16) === 1 && B.decimalsFor(0, 160, 16) === 0, '');
const at = B.parseAt(['1:00', 30, '30.01', 'x'.repeat(3)], 200);
check('at: a bad timestamp is named', /not a timestamp/.test(at.error || ''), JSON.stringify(at));
check('at: past the end is refused, near-duplicates collapse, max 8', /past the end/.test(B.parseAt(['5:00'], 120).error) && B.parseAt(['1:00', 60, '60.01'], 200).times.length === 1 && B.parseAt(Array.from({ length: 12 }, (_, i) => i * 10), 400).times.length === 8, '');
check('at: nothing given is an error', Boolean(B.parseAt([], 10).error) && Boolean(B.parseAt(undefined, 10).error), '');

// ---- model family and token estimates
check('family: picked from the model string, Claude when unknown', B.familyOf('claude-sonnet-5') === 'anthropic' && B.familyOf('openai:gpt-5') === 'openai' && B.familyOf('codex:gpt-5-codex') === 'openai' && B.familyOf('antigravity:gemini-3-pro') === 'gemini' && B.familyOf('openrouter:google/gemini-2.5-pro') === 'gemini' && B.familyOf(undefined) === 'anthropic' && B.familyOf('grokbuild:grok-4') === 'openai', '');
const a1 = B.fitImage('anthropic', 1000, 1000);
check('tokens: Claude is w*h/750 below its limits', a1.tokens === Math.ceil(1000 * 1000 / 750) - 0 || a1.tokens === 1334, JSON.stringify(a1));
const a2 = B.fitImage('anthropic', 4000, 3000);
check('tokens: Claude downsizes a big image to its long edge and ~1,600 tokens', a2.width <= 1568 && a2.tokens <= 1600 && a2.tokens > 1400, JSON.stringify(a2));
const o1 = B.fitImage('openai', 2000, 2000);
check('tokens: OpenAI tiles: fit 2048, short side 768, then 85 + 170 per 512 tile (765)', o1.width === 768 && o1.height === 768 && o1.tokens === 85 + 170 * 4, JSON.stringify(o1));
check('tokens: OpenAI small image is one tile (255)', B.imageTokens('openai', 400, 300) === 255, '');
check('tokens: Gemini 258 up to 384 px, tiles above', B.imageTokens('gemini', 300, 200) === 258 && B.imageTokens('gemini', 1568, 882) > 258 && B.imageTokens('gemini', 1568, 882) % 258 === 0, '');

// ---- planning a sheet
const p0 = B.planSheet({ family: 'anthropic', srcW: 1920, srcH: 1080 });
check('sheet: default is 16 frames in a 4x4 grid within the default budget', p0.frames === 16 && p0.cols === 4 && p0.rows === 4 && p0.tokens <= B.DEFAULT_BUDGET && p0.width <= B.SHEET_MAX_WIDTH && p0.notes.length === 0, JSON.stringify(p0));
check('sheet: cells keep the video aspect and the layout math adds up', Math.abs(p0.cellW / p0.cellH - 16 / 9) < 0.02 && p0.width === p0.cols * p0.cellW + (p0.cols + 1) * B.GAP && p0.height === p0.rows * p0.cellH + (p0.rows + 1) * B.GAP, JSON.stringify(p0));
const p1 = B.planSheet({ family: 'anthropic', srcW: 1920, srcH: 1080, frames: 99 });
check('sheet: frames clamp to 4-36', p1.frames === 36 && B.planSheet({ frames: 1 }).frames === 4, p1.frames);
const p2 = B.planSheet({ family: 'openai', srcW: 1920, srcH: 1080, frames: 16, tokenBudget: 600 });
check('sheet: a small budget shrinks the sheet, then drops frames, and the result fits', p2.tokens <= 600 && p2.frames >= B.MIN_FRAMES && p2.frames <= 16 && p2.notes.length >= 1, JSON.stringify(p2));
const p3 = B.planSheet({ family: 'openai', srcW: 1920, srcH: 1080, frames: 16, tokenBudget: 200 });
check('sheet: an impossible budget gets the smallest sheet and says it is over', p3.frames === 4 && p3.tokens > 200 && /Over the 200-token budget/.test(p3.notes.join(' ')), JSON.stringify(p3));
const p4 = B.planSheet({ family: 'anthropic', srcW: 320, srcH: 180, frames: 16 });
check('sheet: never upscales a small video (cells <= its width, min cell size aside)', p4.cellW <= Math.max(B.MIN_CELL_WIDTH, 320), JSON.stringify(p4));
const p5 = B.planSheet({ family: 'gemini', srcW: 1080, srcH: 1920, frames: 12 });
check('sheet: a portrait video gets taller cells and a grid with more columns than rows is not forced', p5.cellH > p5.cellW && p5.cols * p5.rows >= 12 && p5.cols * p5.rows - 12 <= 2, JSON.stringify(p5));
check('grid: no empty cells for a square count', [4, 9, 16, 25, 36].every((n) => { const g = B.gridFor(n); return g.cols * g.rows === n; }), '');
const f1 = B.planFrames({ family: 'anthropic', srcW: 1920, srcH: 1080, count: 3 });
check('frames: up to 4 are separate 1024-wide images', f1.mode === 'single' && f1.cellW === 1024 && f1.tokens === f1.each * 3, JSON.stringify(f1));
const f2 = B.planFrames({ family: 'anthropic', srcW: 1920, srcH: 1080, count: 7 });
check('frames: more than 4 come as a 2-column sheet', f2.mode === 'sheet' && f2.cols === 2 && f2.rows === 4 && f2.width <= B.SHEET_MAX_WIDTH, JSON.stringify(f2));
check('frames: max_width is honoured and capped, and a small video is not upscaled', B.planFrames({ srcW: 1920, srcH: 1080, count: 1, maxWidth: 400 }).cellW === 400 && B.planFrames({ srcW: 1920, srcH: 1080, count: 1, maxWidth: 9999 }).cellW === 1568 && B.planFrames({ srcW: 500, srcH: 300, count: 1 }).cellW === 500, '');

// ---- sheet pixels
const px = (buf, w, x, y) => [buf[(y * w + x) * 4 + 2], buf[(y * w + x) * 4 + 1], buf[(y * w + x) * 4]];
{
  const w = 100, h = 60;
  const buf = Buffer.alloc(w * h * 4, 128);
  S.drawLabel(buf, w, h, '1:23.4', { scale: 1 });
  let white = 0;
  for (let i = 0; i < w * h; i++) if (buf[i * 4] === 255) white++;
  check('label: draws white digits on a black box, top-left, and nothing else', white > 20 && px(buf, w, 0, 0).join() === '0,0,0' && px(buf, w, w - 1, h - 1).join() === '128,128,128', `${white}`);
  check('label: every character of a timestamp has a glyph', [...'0123456789:.'].every((c) => S.GLYPHS[c] && S.GLYPHS[c].length === S.GLYPH_H && S.GLYPHS[c].every((r) => r.length === S.GLYPH_W)), '');
  const solid = (r, g, b, cw, ch) => { const x = Buffer.alloc(cw * ch * 4); for (let i = 0; i < cw * ch; i++) { x[i * 4] = b; x[i * 4 + 1] = g; x[i * 4 + 2] = r; x[i * 4 + 3] = 255; } return x; };
  const layout = { cols: 2, rows: 2, cellW: 40, cellH: 30, gap: 4, ...B.sheetSize({ cols: 2, rows: 2, cellW: 40, cellH: 30 }) };
  const out = S.composeSheet(layout, [
    { bitmap: solid(200, 0, 0, 40, 30), width: 40, height: 30, label: '0:05' },
    { bitmap: solid(0, 200, 0, 40, 30), width: 40, height: 30, label: '0:15' },
    { bitmap: solid(0, 0, 200, 40, 30), width: 40, height: 30, label: '0:25' },
  ]);
  check('compose: buffer is width x height x 4', out.length === layout.width * layout.height * 4, `${out.length}`);
  check('compose: cells land in reading order at gap + n * (cell + gap)', px(out, layout.width, 4 + 30, 4 + 25).join() === '200,0,0' && px(out, layout.width, 48 + 30, 4 + 25).join() === '0,200,0' && px(out, layout.width, 4 + 30, 38 + 25).join() === '0,0,200', JSON.stringify([px(out, layout.width, 34, 29), px(out, layout.width, 78, 29), px(out, layout.width, 34, 63)]));
  check('compose: the gap and a missing cell are dark', px(out, layout.width, 2, 2).join() === '20,20,20' && px(out, layout.width, 48 + 30, 38 + 25).join() === '20,20,20', '');
  check('compose: a smaller bitmap is centred, not stretched', (() => { const o = S.composeSheet({ ...layout }, [{ bitmap: solid(9, 9, 9, 20, 10), width: 20, height: 10 }]); return px(o, layout.width, 4 + 20, 4 + 15).join() === '9,9,9' && px(o, layout.width, 4 + 2, 4 + 2).join() === '20,20,20'; })(), '');
  check('blank: a flat dark frame is blank, a picture is not', S.looksBlank(solid(2, 2, 2, 20, 20)) && !S.looksBlank(solid(120, 90, 60, 20, 20)) && S.looksBlank(Buffer.alloc(0)), '');
}

// ---- the page scripts against a fake <video>
function fakeEnv(opts = {}) {
  const video = {
    currentTime: opts.currentTime ?? 62, paused: opts.paused ?? false, muted: opts.muted ?? false, ended: false, readyState: 4, networkState: 1,
    duration: opts.duration ?? 200, videoWidth: opts.vw ?? 1920, videoHeight: opts.vh ?? 1080, mediaKeys: opts.drm ? {} : null,
    listeners: {}, plays: 0, pauses: 0, seeks: [],
    addEventListener(ev, f) { (this.listeners[ev] ||= new Set()).add(f); },
    removeEventListener(ev, f) { this.listeners[ev]?.delete(f); },
    fire(ev) { for (const f of [...(this.listeners[ev] || [])]) f(); },
    pause() { this.paused = true; this.pauses++; },
    play() { this.plays++; if (opts.playFails) return Promise.reject(new Error('NotAllowedError')); this.paused = false; return Promise.resolve(); },
    getBoundingClientRect() { return { left: 100, top: 50, right: 740, bottom: 410, width: 640, height: 360 }; },
    scrollIntoView() { env.window.scrollY = 999; },
    requestVideoFrameCallback(cb) { setTimeout(cb, 1); return 1; },
    cancelVideoFrameCallback() {},
    shadowRoot: null,
  };
  let t = video.currentTime;
  Object.defineProperty(video, 'currentTime', { get: () => t, set: (v) => { t = v; video.seeks.push(v); setTimeout(() => video.fire('seeked'), 1); } });
  video.seeks.length = 0;
  const canvas = () => ({ width: 0, height: 0, getContext: () => ({ drawImage() { if (opts.taint) this.tainted = true; }, getImageData() { if (opts.taint) throw new Error('SecurityError'); return {}; } }), toDataURL: (type, q) => `data:image/jpeg;base64,FAKE-${canvas.n = (canvas.n || 0) + 1}` });
  const env = {
    video,
    document: { querySelectorAll: (sel) => (sel === 'video' ? (opts.none ? [] : [video]) : []), createElement: () => canvas() },
    window: { innerWidth: 1000, innerHeight: 700, scrollX: 3, scrollY: 40, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } },
    getComputedStyle: () => ({ objectFit: 'contain' }),
  };
  if (opts.live) video.duration = Infinity;
  return env;
}
const withEnv = async (env, fn) => {
  const keep = { document: global.document, window: global.window, getComputedStyle: global.getComputedStyle };
  global.document = env.document; global.window = env.window; global.getComputedStyle = env.getComputedStyle;
  try { return await fn(); } finally { Object.assign(global, keep); for (const k of Object.keys(keep)) if (keep[k] === undefined) delete global[k]; }
};
const runIn = (env) => (wc, code) => withEnv(env, () => eval(code)); // the serialized script, run against the fake page

(async () => {
  {
    const env = fakeEnv();
    const run = runIn(env);
    const info = await run(null, V.script(V.pageBegin, {}));
    check('begin: finds the video, pauses it and reports its facts', info.duration === 200 && info.vw === 1920 && info.wasPlaying === true && info.at === 62 && info.tainted === false && info.count === 1 && env.video.paused === true, JSON.stringify(info));
    const s = await run(null, V.script(V.pageSeek, { t: 30, timeout: 500, grab: { w: 320, h: 180, q: 0.8 } }));
    check('seek: moves to the time, waits for the frame and returns a JPEG data URL', s.t === 30 && s.seeked && s.framed && /^data:image\/jpeg/.test(s.dataUrl), JSON.stringify(s));
    const end = await run(null, V.script(V.pageEnd));
    check('end: position, playing state and muted are back exactly as they were', env.video.currentTime === 62 && env.video.paused === false && env.video.plays === 1 && end.resumed === true && end.wasPlaying === true && end.at === 62, JSON.stringify(end));
    check('end: the saved state is gone, a second end is a no-op', (await run(null, V.script(V.pageEnd))) === null, '');
  }
  {
    const env = fakeEnv({ paused: true, muted: true, currentTime: 10 });
    const run = runIn(env);
    await run(null, V.script(V.pageBegin, {}));
    await run(null, V.script(V.pageSeek, { t: 100, timeout: 500, grab: { w: 8, h: 8, q: 0.8 } }));
    const end = await run(null, V.script(V.pageEnd));
    check('end: a video the user had paused stays paused (never played), muted kept', env.video.paused === true && env.video.plays === 0 && env.video.muted === true && env.video.currentTime === 10 && end.wasPlaying === false, JSON.stringify(end));
  }
  {
    const env = fakeEnv({ playFails: true });
    const run = runIn(env);
    await run(null, V.script(V.pageBegin, {}));
    const end = await run(null, V.script(V.pageEnd));
    check('end: when the page refuses to resume it is reported, not hidden', end.resumed === false && /NotAllowed/.test(end.error) && /could not be resumed/.test(V.restoreText(end)) && /1:02/.test(V.restoreText(end)), JSON.stringify(end));
  }
  {
    const run = runIn(fakeEnv({ none: true }));
    check('no video: reported with a code and a plain message', (await run(null, V.script(V.pageBegin, {}))).code === 'none' && /No <video> found/.test(V.problemText('none')), '');
    const env2 = fakeEnv({ drm: true });
    const r2 = await runIn(env2)(null, V.script(V.pageBegin, {}));
    check('DRM: code drm, the video is not paused or moved', r2.code === 'drm' && env2.video.pauses === 0 && env2.video.paused === false && /DRM-protected/.test(V.problemText('drm')), JSON.stringify(r2));
    check('live stream: refused with a message that points at screenshot', (await runIn(fakeEnv({ live: true }))(null, V.script(V.pageBegin, {}))).code === 'live' && /screenshot/.test(V.problemText('live')), '');
  }
  {
    const env = fakeEnv({ taint: true, paused: true });
    const run = runIn(env);
    const info = await run(null, V.script(V.pageBegin, {}));
    check('tainted canvas: detected, the video is scrolled into view', info.tainted === true && env.window.scrollY === 999, JSON.stringify(info));
    const s = await run(null, V.script(V.pageSeek, { t: 20, timeout: 500 }));
    check('tainted: seek returns the picture box (letterboxed to the video aspect) in view pixels instead of a data URL', !s.dataUrl && Math.abs(s.rect.w / s.rect.h - 16 / 9) < 0.01 && s.rect.x === 100 && s.viewport.w === 1000, JSON.stringify(s));
    await run(null, V.script(V.pageEnd));
    check('tainted: the scroll position is put back', env.window.scrollX === 3 && env.window.scrollY === 40, JSON.stringify(env.window));
  }
  {
    const env = fakeEnv();
    const run = runIn(env);
    await run(null, V.script(V.pageBegin, { watchdog: 30 }));
    env.video.paused = true;
    await withEnv(env, () => new Promise((r) => setTimeout(r, 80)));
    check('watchdog: if nothing ever ends the capture the page puts playback back by itself', env.video.paused === false && env.video.currentTime === 62, JSON.stringify([env.video.paused, env.video.currentTime]));
  }

  // ---- the tools end to end (fake page, fake image API)
  const fakeImage = (w, h, fill = 150) => ({ getSize: () => ({ width: w, height: h }), resize: ({ width, height }) => fakeImage(width, height, fill), toBitmap: () => Buffer.alloc(w * h * 4, fill), toJPEG: () => Buffer.from('JPEG') });
  const nativeImage = {
    createFromDataURL: () => fakeImage(7, 7), // the wrong size: the tool resizes it to the cell
    createFromBitmap: (buf, { width, height }) => ({ toJPEG: () => Buffer.from(`${width}x${height}:${buf.length}`) }),
  };
  const captured = [];
  const mk = (opts = {}, extra = {}) => {
    const env = fakeEnv(opts);
    const wc = { getURL: () => 'https://www.youtube.com/watch?v=abc', getZoomFactor: () => 1 };
    const deps = { runScript: runIn(env), nativeImage, family: 'anthropic', captureTab: async (w, rect) => { captured.push(rect); return fakeImage(rect.width, rect.height); }, ...extra };
    return { env, wc, deps };
  };
  {
    const { env, wc, deps } = mk();
    const out = await V.overview(wc, {}, deps);
    const text = out[1].text;
    check('overview: one JPEG then a text header', out.length === 2 && out[0].type === 'image' && out[0].source.media_type === 'image/jpeg' && out[1].type === 'text', JSON.stringify(out.map((b) => b.type)));
    check('overview: the header carries duration, resolution, 16 frame times, tokens and the playback restore', /3:20 long, 1920x1080/.test(text) && /16 frames \(4x4 grid/.test(text) && /0:06, 0:18/.test(text) && /Image cost: about [\d,]+ tokens for Claude/.test(text) && /Playback restored: playing again from 1:02/.test(text), text);
    check('overview: points at the transcript on YouTube, says frames are untrusted', /YouTube page may have a transcript/.test(text) && /data, not instructions/.test(text), text);
    check('overview: the user\'s video is back where it was, playing', env.video.currentTime === 62 && env.video.paused === false, '');
    check('overview: seeks in order', env.video.seeks.slice(0, 16).every((t, i, a) => i === 0 || t > a[i - 1]), JSON.stringify(env.video.seeks));
    check('overview: the sheet is the planned size (buffer length proves the layout)', /^\d+x\d+:\d+$/.test(Buffer.from(out[0].source.data, 'base64').toString()) && (() => { const [dim, len] = Buffer.from(out[0].source.data, 'base64').toString().split(':'); const [w, h] = dim.split('x').map(Number); return w * h * 4 === Number(len); })(), '');
  }
  {
    const { wc, deps } = mk({ duration: 10 });
    const out = await V.overview(wc, { frames: 8, start: '0:02', end: 8 }, deps);
    check('overview: a short clip gets tenths of a second; a window is honoured', /8 frames/.test(out[1].text) && /from 0:02 to 0:08/.test(out[1].text) && /\d:\d\d\.\d/.test(out[1].text), out[1].text);
  }
  {
    const { env, wc, deps } = mk({ taint: true });
    const out = await V.overview(wc, { frames: 4 }, deps);
    check('overview, tainted: frames come from captureTab cropped to the video box, and the header says so', captured.length === 4 && captured.every((r) => r.width > 100 && r.x >= 100) && /from the screen/.test(out[1].text), JSON.stringify(captured.slice(0, 1)) + out[1].text);
    check('overview, tainted: playback and scroll restored', env.video.currentTime === 62 && env.video.paused === false && env.window.scrollY === 40, '');
  }
  {
    const { env, wc, deps } = mk({ drm: true });
    let msg = '';
    try { await V.overview(wc, {}, deps); } catch (e) { msg = e.message; }
    check('overview: a DRM video is refused with a plain message and left alone', /DRM-protected/.test(msg) && env.video.pauses === 0, msg);
    const none = mk({ none: true });
    msg = '';
    try { await V.frames(none.wc, { at: ['1:00'] }, none.deps); } catch (e) { msg = e.message; }
    check('frames: no video is a plain message', /No <video> found/.test(msg), msg);
  }
  {
    const { env, wc, deps } = mk();
    let msg = '';
    try { await V.overview(wc, { start: 'later' }, deps); } catch (e) { msg = e.message; }
    check('overview: a bad start is named', /start "later" is not a timestamp/.test(msg), msg);
    msg = '';
    try { await V.overview(wc, { start: 190, end: 190.05 }, deps); } catch (e) { msg = e.message; }
    check('overview: an empty window is an error and playback still comes back', /Nothing to show/.test(msg) && env.video.currentTime === 62 && env.video.paused === false, msg);
  }
  {
    const { env, wc, deps } = mk();
    const ctl = new AbortController();
    let n = 0;
    const inner = deps.runScript;
    deps.runScript = (w, code, ms) => { if (/pageSeek|seeked/.test(code) && ++n === 3) ctl.abort(); return inner(w, code, ms); };
    deps.signal = ctl.signal;
    let msg = '';
    try { await V.overview(wc, {}, deps); } catch (e) { msg = e.message; }
    check('stopping mid-capture ends the run and still restores playback', /Stopped/.test(msg) && env.video.currentTime === 62 && env.video.paused === false, msg);
  }
  {
    const { wc, deps } = mk();
    let calls = 0;
    const inner = deps.runScript;
    deps.runScript = (w, code, ms) => { if (/a\.grab/.test(code) && ++calls === 2) return Promise.reject(new Error('The page did not respond.')); return inner(w, code, ms); };
    const out = await V.overview(wc, { frames: 4 }, deps);
    check('overview: one frame that fails is skipped and counted, not fatal', /3 frames/.test(out[1].text) && /1 frame could not be captured and is missing/.test(out[1].text), out[1].text);
  }
  {
    const { env, wc, deps } = mk();
    const out = await V.frames(wc, { at: ['0:30', 95, '2:00'] }, deps);
    check('frames: up to 4 come as separate images then a text block, sorted by time', out.length === 4 && out.slice(0, 3).every((b) => b.type === 'image') && /0:30, 1:35, 2:00/.test(out[3].text) && /1024px wide each/.test(out[3].text), out[3].text);
    check('frames: playback restored', env.video.currentTime === 62 && env.video.paused === false && /Playback restored/.test(out[3].text), '');
    const many = await V.frames(wc, { at: [5, 20, 40, 60, 80, 100, 120] }, deps);
    check('frames: 7 timestamps come as one 2-column sheet', many.length === 2 && many[0].type === 'image' && /one 2-column sheet/.test(many[1].text), many.map((b) => b.type).join());
    let msg = '';
    try { await V.frames(wc, { at: ['9:00'] }, deps); } catch (e) { msg = e.message; }
    check('frames: past the end is refused and playback is still restored', /past the end/.test(msg) && env.video.currentTime === 62, msg);
    check('frames: for OpenAI the cost uses tile maths', /tokens for OpenAI/.test((await V.frames(wc, { at: [5] }, { ...deps, family: 'openai' }))[1].text), '');
  }

  // ---- registration
  const agentSrc = read('src/ai/agent.js');
  const { EXTERNAL_TOOLS, validateInput, requestFor, DEFAULT_MODEL } = require('../src/ai/agent');
  const mcp = require('../src/automation/mcp');
  const names = ['video_overview', 'video_frames'];
  const msgs = Object.assign([{ role: 'user', content: 'hi' }], { settings: { model: DEFAULT_MODEL } });
  const apiTools = requestFor(msgs.settings, msgs).tools;
  check('tools: both are in the model\'s tool list and the one outside agents see', names.every((n) => apiTools.some((t) => t.name === n) && EXTERNAL_TOOLS.some((t) => t.name === n)), '');
  const ext = Object.fromEntries(EXTERNAL_TOOLS.map((t) => [t.name, t]));
  check('tools: rare options (start, end, token_budget) are left out of the slim listing but still validated', !('token_budget' in ext.video_overview.input_schema.properties) && !('start' in ext.video_overview.input_schema.properties) && 'frames' in ext.video_overview.input_schema.properties && validateInput('video_overview', { token_budget: 'many' }) === 'Field token_budget must be a integer', String(validateInput('video_overview', { token_budget: 'many' })));
  check('tools: video_frames requires at; numbers for timestamps are accepted', validateInput('video_frames', {}) === 'Missing required field: at' && validateInput('video_frames', { at: [83, '1:30'] }) === null && validateInput('video_overview', { start: 5, end: 60 }) === null, '');
  check('tools: descriptions stay short (tool-definition budget)', names.every((n) => ext[n].description.length < 160), names.map((n) => ext[n].description.length).join());
  const setOf = (src, name) => { const at = src.indexOf(`${name} = new Set([`); return at < 0 ? '' : src.slice(at, src.indexOf(']', at)); };
  const hasBoth = (src, name) => names.every((n) => setOf(src, name).includes(`'${n}'`));
  const hasNone = (src, name) => names.every((n) => !setOf(src, name).includes(`'${n}'`));
  check('lists: agent.js READING_TOOLS (taints the run, like screenshot)', hasBoth(agentSrc, 'READING_TOOLS'), '');
  check('lists: tab_id is checked against AI-off sites', /name === 'video_overview' \|\| name === 'video_frames'\) && input\.tab_id !== undefined \? \[input\.tab_id\]/.test(agentSrc), '');
  check('lists: neither is a tab-free, destination or acting tool (they use the task tab like screenshot)', ['TAB_FREE_TOOLS', 'DESTINATION_TOOLS', 'ACTING_TOOLS'].every((n) => hasNone(agentSrc, n)), '');
  check('lists: step labels in agent.js, en.json, chat-core.js and the bundle', /name === 'video_overview'\) return 'Looking over the video'/.test(agentSrc) && /"tool\.video_overview"/.test(read('src/locales/en.json')) && /"tool\.video_frames"/.test(read('src/locales/en.json')) && /video_overview: \(\) => t\('tool\.video_overview'\)/.test(read('src/renderer/chat-core.js')) && /video_frames: \(\) => t\('tool\.video_frames'\)/.test(read('src/renderer/ui.bundle.js')), '');
  const lg = read('src/ai/loop-guard.js');
  check('lists: loop-guard STATIC_READS has both; PARALLEL_READS and CACHEABLE do not (they move one video, and return pictures)', hasBoth(lg, 'STATIC_READS') && hasNone(lg, 'PARALLEL_READS') && hasNone(lg, 'CACHEABLE'), '');
  check('lists: snapshot READ_ONLY (a repeat does not count as acting)', hasBoth(read('src/ai/snapshot.js'), 'READ_ONLY'), '');
  check('lists: Claude Code early step labels', /video_overview: 'Looking over the video', video_frames: 'Looking at video frames'/.test(read('src/ai/claude-code.js')), '');
  check('lists: MCP marks both read-only', names.every((n) => mcp.annotationsFor(n)?.readOnlyHint === true), '');
  const { isParallelRead } = require('../src/ai/loop-guard');
  check('loop guard: two video calls are never run side by side', !isParallelRead({ name: 'video_overview', input: {} }) && !isParallelRead({ name: 'video_frames', input: { at: ['1'] } }), '');
  const manners = require('../src/features/ai-manners');
  check('hands-off and off-tab modes leave reading alone (not action tools)', names.every((n) => !manners.isActionTool(n) && manners.handsOffCheck({ tool: n, handsOff: true }) === null), '');
  const docs = read('docs/mcp-tools.md');
  check('docs: both tools are documented', /### `video_overview`/.test(docs) && /### `video_frames`/.test(docs), '');
  check('changelog: an Unreleased entry', /## Unreleased[\s\S]*?\*\*The AI can look at videos\./.test(read('CHANGELOG.md')), '');
  const skills = require('../src/features/skills');
  const sk = skills.BUILTINS.find((b) => b.name === 'watch-video');
  check('skill: /watch-video is built in, uses tools, names both tools, cites times, short', sk && sk.mode === 'agent' && /video_overview/.test(sk.prompt) && /video_frames/.test(sk.prompt) && /m:ss/.test(sk.prompt) && /never guess/.test(sk.prompt) && sk.prompt.length < 700, '');
  const ex = skills.expand(skills.normalizeSkill({ ...sk, source: 'builtin' }).skill, { page: { title: 't', url: 'https://youtu.be/x', text: 'transcript words' }, input: 'what does the demo show?' });
  check('skill: expands with the page text (transcript) and what was typed', ex.ok && /transcript words/.test(ex.prompt) && /what does the demo show\?/.test(ex.prompt), ex.prompt);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll video checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
