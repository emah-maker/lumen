// [desktop apps] The Computer card's live picture (src/desktop/live.js and its hook in src/desktop/index.js), plain Node: a fake clock and a
// stand-in helper that answers "frame" the way uia-helper.ps1 does (an image only when the window changed, "same" when it did not, "skip"
// for a minimized window, the title back instead of a picture when the title is not the approved one). Covers the rate, the change
// detection contract, the pauses (card off screen, minimized, a call running, the person took over, the run over), Light graphics, and the
// safety rules: a window that turned into a blocked program is never captured or kept, whatever the reason it changed.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const policy = require('../../src/desktop/policy');
const { createDesktop } = require('../../src/desktop');
const { createLive, widthFor } = require('../../src/desktop/live');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = JSON.stringify;
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

function makeClock() {
  let t = 1000;
  const q = [];
  let id = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const e = { at: t + ms, fn, id: ++id }; q.push(e); return e; },
    clearTimeout: (e) => { const i = q.indexOf(e); if (i >= 0) q.splice(i, 1); },
    pending: () => q.length,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const e = q[0];
        if (!e || e.at > end) break;
        q.shift();
        t = Math.max(t, e.at);
        e.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

// The helper's contract for "frame", scripted: `content` is what the window shows (a number that changes when it changes).
function fakeHelper(over = {}) {
  const h = { content: 1, sent: null, title: 'Report.docx - Word', pid: 10, gone: false, state: '', ms: 8, calls: [], captures: 0, ...over };
  h.frame = async (args) => {
    h.calls.push(args);
    if (h.gone) throw Object.assign(new Error('That window is gone.'), { fromHelper: true });
    if (args.pid !== h.pid) throw Object.assign(new Error('That window now belongs to a different program. Call list_apps again.'), { fromHelper: true });
    if (args.title !== h.title) return { retitle: h.title }; // not the approved title: nothing is captured
    if (h.state) return { skip: h.state };
    h.captures++;
    if (!args.reset && h.sent === h.content) return { same: true, ms: h.ms };
    h.sent = h.content;
    return { image: `IMG${h.content}`, w: 340, h: 200, ms: h.ms };
  };
  return h;
}

(async () => {
  // ---- the schedule, on its own
  const rigLive = (helper, o = {}) => {
    const clock = makeClock();
    const st = { visible: true, light: false, canRun: true, allowed: true, approved: 'Report.docx - Word', judged: [], frames: [], ended: [], blockedTitles: new Set(), ...o };
    const live = createLive({
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      visible: () => st.visible, light: () => st.light, dpr: () => st.dpr || 1, canRun: () => st.canRun,
      target: () => ({ hwnd: 7, pid: 10, hpid: 0, start: 55 }),
      allowed: () => st.allowed && !st.blockedTitles.has(st.approved),
      judge: (title) => { st.judged.push(title); return !st.blockedTitles.has(title); },
      approved: () => st.approved, approve: (t) => { st.approved = t; },
      frame: (args) => helper.frame(args), onFrame: (img, info) => st.frames.push([clock.now(), img, info]), onEnd: (r) => st.ended.push(r),
    });
    return { clock, st, live, helper };
  };
  const perSec = (n, ms) => Math.round((n / (ms / 1000)) * 10) / 10;

  {
    const helper = fakeHelper();
    const r = rigLive(helper);
    r.live.start();
    // the window changes all the time: each look finds something new
    let t = 0;
    while (t < 10000) { await r.clock.advance(50); helper.content++; t += 50; }
    const fps = perSec(r.st.frames.length, 10000);
    check(`a window that keeps changing: about 3-10 pictures a second (${fps}/s)`, fps >= 3 && fps <= 10, fps);
    check('every picture is a different one (an unchanged frame is never sent)', new Set(r.st.frames.map((f) => f[1])).size === r.st.frames.length);
    r.live.stop();
  }
  {
    const helper = fakeHelper();
    const r = rigLive(helper);
    r.live.start();
    await r.clock.advance(10000);
    const s = r.live.stats();
    check('a window that does not change: one picture, then nothing is sent', r.st.frames.length === 1 && s.frames === 1, J(s));
    check('...and the looks slow down to the quiet pace (about 2 a second)', s.calls <= 30 && s.same >= 10, J(s));
    helper.content++;
    await r.clock.advance(600);
    check('a change after a quiet spell is shown within a moment', r.st.frames.length === 2, r.st.frames.length);
    r.live.stop();
  }
  {
    const helper = fakeHelper();
    const r = rigLive(helper, { light: true });
    r.live.start();
    let t = 0;
    while (t < 10000) { await r.clock.advance(100); helper.content++; t += 100; }
    const fps = perSec(r.st.frames.length, 10000);
    check(`Light graphics / software drawing: a slower rate, at most about 1.5 a second (${fps}/s)`, fps > 0 && fps <= 1.6, fps);
    check('...with a smaller picture (the card width at 1x) and lower quality', helper.calls.every((c) => c.w === 340 && c.q < 50), J(helper.calls[0]));
    check('widths: the card width times the display scale, at most 2x', widthFor(1) === 340 && widthFor(1.5) === 510 && widthFor(2) === 680 && widthFor(3) === 680 && widthFor(2, true) === 340);
    r.live.stop();
  }
  {
    const helper = fakeHelper();
    const r = rigLive(helper, { visible: false });
    r.live.start();
    for (let i = 0; i < 20; i++) { await r.clock.advance(500); helper.content++; }
    check('the card is off screen: the helper is not asked for anything', helper.calls.length === 0 && r.st.frames.length === 0, J(helper.calls.length));
    r.st.visible = true;
    await r.clock.advance(1500);
    check('...and it starts again when the card is back', r.st.frames.length >= 1);
    r.live.stop();
  }
  {
    const helper = fakeHelper({ state: 'minimized' });
    const r = rigLive(helper);
    r.live.start();
    await r.clock.advance(10000);
    check('a minimized window: no pictures, and only a look a second', r.st.frames.length === 0 && helper.calls.length <= 12, J([r.st.frames.length, helper.calls.length]));
    helper.state = 'hidden';
    await r.clock.advance(5000);
    check('a hidden window (or one on another desktop): no pictures either', r.st.frames.length === 0);
    helper.state = '';
    await r.clock.advance(2000);
    check('shown again: a picture comes', r.st.frames.length === 1);
    r.live.stop();
  }
  {
    const helper = fakeHelper();
    const r = rigLive(helper, { canRun: false });
    r.live.start();
    for (let i = 0; i < 20; i++) { await r.clock.advance(250); helper.content++; }
    check('a call is running in the app, or the person took over: no pictures are asked for', helper.calls.length === 0);
    r.st.canRun = true;
    await r.clock.advance(400);
    check('...they continue when it is over', r.st.frames.length >= 1);
    r.live.stop();
    const before = helper.calls.length;
    helper.content++;
    await r.clock.advance(5000);
    check('stopped (Esc, Stop, the end of the run, the window closing): nothing more is asked for', helper.calls.length === before && r.clock.pending() === 0, J([helper.calls.length, before, r.clock.pending()]));
  }
  {
    const helper = fakeHelper({ ms: 220 });
    const r = rigLive(helper);
    r.live.start();
    let t = 0;
    while (t < 10000) { await r.clock.advance(50); helper.content++; t += 50; }
    const helperMs = r.live.stats().helperMs;
    const busy = helperMs / (10000 + helperMs); // (the fake call takes no time of its own: the helper's time is added to the clock)
    check(`an expensive capture slows the pace down: the helper works at most about a third of the time (${Math.round(busy * 100)}%)`, busy <= 0.4, busy);
    r.live.stop();
  }
  {
    // identity and policy
    const helper = fakeHelper();
    const r = rigLive(helper, { approved: null });
    r.live.start();
    await r.clock.advance(500);
    check('with no approved title yet, the first call is answered with the title only, nothing captured', helper.calls[0].title === null && r.st.judged[0] === 'Report.docx - Word', J([helper.calls[0], r.st.judged]));
    check('...the title is judged by the policy, and the pictures come after that', r.st.frames.length >= 1 && helper.captures >= 1 && helper.calls[1].title === 'Report.docx - Word');
    helper.title = 'Online Banking - Chase Online - Google Chrome';
    r.st.blockedTitles.add(helper.title);
    helper.content++;
    const capturesBefore = helper.captures;
    await r.clock.advance(600);
    check('the title turns into a blocked one: it is judged first, nothing is captured, and live stops with "blocked"', r.st.ended.join() === 'blocked' && helper.captures === capturesBefore && !r.live.active(), J([r.st.ended, helper.captures, capturesBefore]));
    const calls = helper.calls.length;
    await r.clock.advance(5000);
    check('...and nothing more is asked for afterwards', helper.calls.length === calls && r.clock.pending() === 0);
  }
  {
    const helper = fakeHelper();
    const r = rigLive(helper);
    r.live.start();
    await r.clock.advance(300);
    helper.pid = 99; // the handle now belongs to another program
    helper.content++;
    await r.clock.advance(600);
    check('the window now belongs to a different program: live stops with "changed"', r.st.ended.join() === 'changed', J(r.st.ended));
    const h2 = fakeHelper();
    const r2 = rigLive(h2);
    r2.live.start();
    await r2.clock.advance(300);
    h2.gone = true;
    await r2.clock.advance(600);
    check('the window closed: live stops with "gone"', r2.st.ended.join() === 'gone', J(r2.st.ended));
    const h3 = fakeHelper();
    const r3 = rigLive(h3);
    r3.live.start();
    await r3.clock.advance(300);
    const sentBefore = r3.st.frames.length;
    r3.st.allowed = false; // the switch was turned off, or the app was revoked, mid-run
    h3.content++;
    await r3.clock.advance(600);
    check('the app stops being allowed (Settings changed mid-run): live stops with "blocked" before another call', r3.st.ended.join() === 'blocked' && r3.st.frames.length === sentBefore, J([r3.st.ended, r3.st.frames.length, sentBefore]));
    const h4 = fakeHelper({ ms: 5 });
    const r4 = rigLive(h4);
    let nCalls = 0;
    const orig = h4.frame;
    h4.frame = async (a) => { nCalls++; const out = await orig(a); r4.st.allowed = false; return out; }; // blocked while a picture is on its way
    r4.live.start();
    await r4.clock.advance(400);
    check('a picture that arrives after the window became blocked is dropped, never shown', r4.st.frames.length === 0 && r4.st.ended.join() === 'blocked' && nCalls === 1, J([r4.st.frames.length, r4.st.ended, nCalls]));
    const h5 = fakeHelper();
    const r5 = rigLive(h5);
    let n = 0;
    h5.frame = async () => { n++; throw new Error('The app did not answer in time (frame).'); };
    r5.live.start();
    await r5.clock.advance(120000);
    check('a helper that keeps failing: live backs off, tries 8 times and gives up', r5.st.ended.join() === 'failed' && !r5.live.active() && n === 8, J([n, r5.st.ended]));
  }

  {
    // a title that changes every moment (a progress percentage, a clock): asked about again at once, so it does not starve the pictures
    const helper = fakeHelper({ ms: 40 });
    const r = rigLive(helper);
    const times = [];
    const orig = helper.frame;
    helper.frame = async (a) => { times.push([r.clock.now(), a.title]); return orig(a); };
    r.live.start();
    let t = 0;
    while (t < 5000) { await r.clock.advance(100); helper.title = 'Report ' + (t / 100); helper.content++; t += 100; }
    check('a title that changes all the time: each new title is judged and the picture follows at once (pictures keep coming)', r.live.stats().retitled >= 10 && r.st.frames.length >= 10, J(r.live.stats()));
    r.live.stop();
  }

  // ---- inside the desktop controller, with a stand-in helper
  const WORDX = 'C:\\Office\\WINWORD.EXE';
  const CHROMEX = 'C:\\Google\\chrome.exe';
  const key = (exe) => policy.exeKey(exe);
  const mk = (hwnd, pid, proc, title, exe, extra = {}) => ({ hwnd, pid, proc, title, exe, description: '', start: 1000 + pid, ...extra });
  const word = mk(100, 10, 'WINWORD', 'Report.docx - Word', WORDX, { description: 'Microsoft Word' });
  const rigDesktop = (win, { light = false, visible = true } = {}) => {
    const clock = makeClock();
    const helper = fakeHelper({ title: win.title, pid: win.pid });
    const store = { win, master: true, allowed: [{ app: key(win.exe), name: policy.friendlyName(win.proc, win.description) }], visible, light, calls: [], aborted: 0, cursor: { x: 0, y: 0 }, over: 0 };
    const client = {
      call: async (cmd, args = {}) => {
        store.calls.push([cmd, args]);
        if (cmd === 'apps') return { ok: true, apps: [store.win] };
        if (cmd === 'tree') return { ok: true, tree: { t: 'ControlType.Window', n: 'Form', i: 'e1', c: [] } };
        if (cmd === 'frame') return { ok: true, ...(await helper.frame(args)) };
        if (cmd === 'shot') return { ok: true, image: 'SHOT' };
        return { ok: true };
      },
      abort() { store.aborted++; }, destroy() {},
    };
    const settings = { master: () => store.master, terminals: () => false, allowed: () => store.allowed, allow() {}, setMaster() {} };
    const events = [];
    const stops = [];
    const api = { ok: true, cursor: () => store.cursor, pidUnderCursor: () => store.over, foregroundPid: () => 0, escapeDown: () => false, mouseDown: () => false, typing: () => false };
    const ban = { async show() {}, async update() {}, hide() {} };
    const d = createDesktop({
      client, settings, banner: ban, winapi: api, platform: 'win32', stopRun: () => stops.push(1), icon: async () => null, now: clock.now,
      shortcut: { register() {}, unregister() {} }, lumen: { pid: 4242, exe: 'C:\\Lumen\\Lumen.exe' },
      live: { visible: () => store.visible, light: () => store.light, dpr: () => 2, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    });
    const ctx = { emit: (e) => events.push(e), signal: new AbortController().signal, once: new Set(), tainted: () => false, ask: async () => true };
    const cards = () => events.filter((e) => e.type === 'desktop_card');
    const pictures = () => cards().filter((e) => e.thumbnail && /^data:image\/jpeg;base64,/.test(e.thumbnail));
    return { d, clock, helper, store, events, ctx, stops, cards, pictures };
  };

  {
    const rig = rigDesktop(word);
    await rig.d.run({ action: 'read_app', args: { id: 'w100' } }, rig.ctx);
    await rig.clock.advance(300);
    check('the controller shows a live picture in the card: a data: image from the helper\'s frame', rig.pictures().length >= 1 && rig.pictures()[0].thumbnail === 'data:image/jpeg;base64,IMG1', J(rig.cards().map((e) => e.thumbnail && e.thumbnail.slice(0, 30))));
    const calls = rig.store.calls.filter(([c]) => c === 'frame');
    check('the frame call names the window, the program (pid) and the card width at 2x', calls[0][1].hwnd === 100 && calls[0][1].pid === 10 && calls[0][1].w === 680, J(calls[0][1]));
    check('the first call carries no title (the helper answers with it, the policy judges it); every later call carries the approved one', calls[0][1].title === null && calls.slice(1).every(([, a]) => a.title === 'Report.docx - Word') && calls.length > 1);
    const n1 = rig.pictures().length;
    for (let i = 0; i < 20; i++) { await rig.clock.advance(120); rig.helper.content++; }
    check('as the window changes, new pictures arrive in the card', rig.pictures().length >= n1 + 10, rig.pictures().length - n1);
    const stat = rig.d.liveStats();
    check('stats: pictures, looks and helper time', stat && stat.frames >= 10 && stat.calls >= stat.frames, J(stat));

    rig.store.light = true;
    const m = rig.pictures().length;
    for (let i = 0; i < 20; i++) { await rig.clock.advance(100); rig.helper.content++; }
    check('Light graphics inside the controller: at most 3 pictures in 2 seconds', rig.pictures().length - m <= 3, rig.pictures().length - m);
    rig.store.light = false;

    rig.store.visible = false;
    const k = rig.helper.calls.length;
    for (let i = 0; i < 10; i++) { await rig.clock.advance(300); rig.helper.content++; }
    check('card off screen: the helper is not asked for pictures', rig.helper.calls.length === k, rig.helper.calls.length - k);
    rig.store.visible = true;
    await rig.clock.advance(1500);
    check('card back on screen: pictures again', rig.helper.calls.length > k);

    rig.d.finishRun();
    const last = rig.cards()[rig.cards().length - 1];
    const after = rig.helper.calls.length;
    for (let i = 0; i < 10; i++) { await rig.clock.advance(300); rig.helper.content++; }
    check('the end of the run: the card says completed with its one last picture; no more pictures are asked for', last.status === 'completed' && /^data:image\/jpeg/.test(last.thumbnail) && rig.helper.calls.length === after, J([last.status, rig.helper.calls.length, after]));
  }
  {
    const rig = rigDesktop(word);
    await rig.d.run({ action: 'read_app', args: { id: 'w100' } }, rig.ctx);
    await rig.clock.advance(300);
    rig.d.stop('card');
    const n = rig.helper.calls.length;
    for (let i = 0; i < 10; i++) { await rig.clock.advance(300); rig.helper.content++; }
    check('Stop: no more pictures are asked for', rig.helper.calls.length === n && !rig.d.active() && rig.cards()[rig.cards().length - 1].status === 'stopped');
  }
  {
    // the person takes over (the mouse moves over the app): pictures stop until Resume
    const rig = rigDesktop(word);
    await rig.d.run({ action: 'read_app', args: { id: 'w100' } }, rig.ctx);
    await rig.clock.advance(300);
    rig.store.over = 10;
    rig.store.cursor = { x: 600, y: 600 };
    rig.d._poll();
    check('(rig) the person moved the mouse over the app: paused', rig.d.paused());
    await rig.clock.advance(300);
    const n = rig.helper.calls.length;
    for (let i = 0; i < 10; i++) { await rig.clock.advance(300); rig.helper.content++; }
    check('taking over: no pictures are asked for while paused', rig.helper.calls.length === n, rig.helper.calls.length - n);
    rig.d.resume();
    await rig.clock.advance(600);
    check('Resume: the pictures go on', rig.helper.calls.length > n);
    rig.d.destroy();
  }
  {
    // an action in the app: no pictures are asked for while it runs (the helper is busy), they go on after
    const rig = rigDesktop(word);
    await rig.d.run({ action: 'read_app', args: { id: 'w100' } }, rig.ctx);
    await rig.clock.advance(300);
    const before = rig.helper.calls.length;
    await rig.d.run({ action: 'read_app', args: { id: 'w100' } }, rig.ctx);
    await rig.clock.advance(600);
    check('after a call in the app the pictures go on', rig.helper.calls.length > before);
    rig.d.destroy();
  }
  {
    // a window that turns into a blocked program (a bank in the browser) is never captured, and its picture is not kept
    const chrome = mk(200, 20, 'chrome', 'Docs - Google Chrome', CHROMEX, { description: 'Google Chrome' });
    const rig = rigDesktop(chrome);
    await rig.d.run({ action: 'read_app', args: { id: 'w200' } }, rig.ctx);
    await rig.clock.advance(400);
    check('(rig) a browser window the user allowed gets pictures', rig.pictures().length >= 1, rig.pictures().length);
    const capturesBefore = rig.helper.captures;
    rig.helper.title = 'Online Banking - Chase Online - Google Chrome';
    rig.helper.content++;
    await rig.clock.advance(500);
    const lastEv = rig.cards()[rig.cards().length - 1];
    check('the window turns into a bank: nothing is captured after the change, the session ends, and the card is told to show the placeholder (no picture)', rig.helper.captures === capturesBefore && !rig.d.active() && lastEv.status === 'stopped' && lastEv.blocked === true && lastEv.thumbnail === null, J([rig.helper.captures, capturesBefore, rig.d.active(), { ...lastEv, icon: '' }]));
    const n = rig.helper.calls.length;
    await rig.clock.advance(5000);
    check('...and nothing more is asked for', rig.helper.calls.length === n);
  }
  {
    // the window's program changes (the handle is reused by another program), or the window closes
    const rig = rigDesktop(word);
    await rig.d.run({ action: 'read_app', args: { id: 'w100' } }, rig.ctx);
    await rig.clock.advance(400);
    rig.helper.pid = 4242;
    await rig.clock.advance(1500);
    const lastEv = rig.cards()[rig.cards().length - 1];
    check('the window now belongs to another program: the session ends and the picture is dropped (placeholder)', !rig.d.active() && lastEv.status === 'stopped' && lastEv.blocked === true && lastEv.thumbnail === null, J([rig.d.active(), { ...lastEv, icon: '' }]));
    const closed = rigDesktop(word);
    await closed.d.run({ action: 'read_app', args: { id: 'w100' } }, closed.ctx);
    await closed.clock.advance(400);
    closed.helper.gone = true;
    await closed.clock.advance(1500);
    const ev = closed.cards()[closed.cards().length - 1];
    check('the window closes: the session ends as stopped and the last picture stays', !closed.d.active() && ev.status === 'stopped' && !ev.blocked && /^data:image\/jpeg/.test(ev.thumbnail), J([closed.d.active(), ev.status]));
  }
  {
    // the master switch turned off mid-run: no more pictures
    const rig = rigDesktop(word);
    await rig.d.run({ action: 'read_app', args: { id: 'w100' } }, rig.ctx);
    await rig.clock.advance(400);
    rig.store.master = false;
    const n = rig.helper.calls.length;
    await rig.clock.advance(1000);
    check('Settings → AI switched off mid-run: no more pictures, and the card shows the placeholder', rig.helper.calls.length <= n + 1 && !rig.d.active() && rig.cards()[rig.cards().length - 1].blocked === true, J([rig.helper.calls.length, n, rig.d.active()]));
  }
  {
    // no live picture unless it was switched on
    const plain = createDesktop({
      client: { call: async (cmd) => (cmd === 'apps' ? { ok: true, apps: [word] } : cmd === 'shot' ? { ok: true, image: 'QUJD' } : { ok: true, tree: { t: 'ControlType.Window', n: 'F', i: 'e1', c: [] } }), abort() {}, destroy() {} },
      settings: { master: () => true, terminals: () => false, allowed: () => [{ app: key(WORDX), name: 'Word' }], allow() {}, setMaster() {} },
      banner: { async show() {}, async update() {}, hide() {} }, winapi: { ok: true, cursor: () => ({ x: 0, y: 0 }), pidUnderCursor: () => 0, foregroundPid: () => 0, escapeDown: () => false, mouseDown: () => false, typing: () => false },
      platform: 'win32', stopRun: () => {}, icon: async () => null, shortcut: { register() {}, unregister() {} }, lumen: { pid: 4242, exe: 'C:\\Lumen\\Lumen.exe' },
    });
    await plain.run({ action: 'read_app', args: { id: 'w100' } }, { emit: () => {}, signal: new AbortController().signal, once: new Set(), tainted: () => false, ask: async () => true });
    check('without live deps the controller has no live loop (the one picture per 1.5 s stays)', plain.liveStats() === null);
    plain.destroy();
  }

  // ---- the files
  {
    const live = read('src/desktop/live.js');
    const idx = read('src/desktop/index.js');
    const ps = read('src/desktop/uia-helper.ps1');
    check('privacy: the live path never writes a picture anywhere (no fs, no saved chat, no log)', !/require\('fs'\)|writeFile|console\.|localStorage/.test(live) && !/writeFile/.test(idx.slice(idx.indexOf('function startLive'), idx.indexOf('async function thumb'))));
    check('helper: the frame is captured with PrintWindow and PW_RENDERFULLCONTENT (2), in the helper process', /PrintWindow\(h, dc, 2\)/.test(ps) && /function Cmd-Frame/.test(ps) && /'frame' \{ return Cmd-Frame/.test(ps));
    const body = ps.slice(ps.indexOf('function Cmd-Frame'));
    check('helper: the owner of the window and its title are checked BEFORE any capture, and a changed title returns without capturing', body.indexOf('OwnerPid') < body.indexOf('[LumenNative]::Frame(') && body.indexOf('retitle') < body.indexOf('[LumenNative]::Frame('));
    check('helper: minimized, hidden and cloaked windows are skipped before PrintWindow', /IsIconic\(h\)\) \{ res\.Skip = "minimized"/.test(ps) && /DwmGetWindowAttribute\(h, 14/.test(ps) && ps.indexOf('res.Skip = "hidden"') < ps.indexOf('PrintWindow(h, dc, 2); g.ReleaseHdc(dc); if (!ok) { res.Skip'));
    check('helper: the picture is made small and encoded as a JPEG in the helper, only when it changed from the last one sent', /Same = true/.test(ps) && /prevPix = cur/.test(ps) && /Convert\.ToBase64String/.test(ps));
    const main = read('src/main.js');
    check('main.js: a frame-only card event skips the run bookkeeping (agent target, run tab) that every other event does', (main.match(/msg\.type !== 'thinking' && !msg\.frame\)/g) || []).length === 2);
    const stepUi = read('src/renderer/step-ui.js');
    check('card: a frame-only event changes only the picture; a blocked end clears it (placeholder)', /event\.frame && card\.surface === 'app'[^\n]*setShot2\(card, event\.thumbnail\); return true/.test(stepUi) && /event\.blocked\) \{ card\.img2\.removeAttribute\('src'\); card\.shot2\.hidden = true/.test(stepUi));
    check('card: clicking the picture or the header goes to the program (desktopOpen with the app id), the picture is a real button with Enter / Space, and the chip works for any program', /card\.shot2\.onclick = \(\) => \{ if \(card\.surface === 'app' && card\.app\?\.id\) openIt\(card\)/.test(stepUi) && /e\.key === 'Enter' \|\| e\.key === ' '/.test(stepUi) && /card\.shot2\.setAttribute\('role', 'button'\); card\.shot2\.tabIndex = 0/.test(stepUi) && /e\.target\.closest\('button, a'\) \|\| String\(window\.getSelection/.test(stepUi) && /function appChip\(card\)/.test(stepUi) && /desktopcard\.show/.test(read('src/locales/en.json')) && /\.act-shot2\[role="button"\]:focus-visible/.test(read('src/renderer/step-ui.css')));
    check('desktop-card.js fallback: the picture is a button too (Enter / Space) and goes to the program like Open', /thumb\.setAttribute\('role', 'button'\); thumb\.tabIndex = 0/.test(read('src/renderer/desktop-card.js')) && /thumb\.onclick = go/.test(read('src/renderer/desktop-card.js')));
    check('main.js: the live picture follows the card-on-screen signal and the Light graphics mode', /live: \{ visible: \(\) => thumbsVisible\(\), light: \(\) => \(TEST && typeof global\.__desktopLight === 'boolean' \? global\.__desktopLight : graphicsMode\.light\(\)/.test(main));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
