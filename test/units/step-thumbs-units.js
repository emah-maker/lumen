// Plain Node: the Browser card's thumbnail scheduling (features/step-thumbs.js), with a fake capture and short timers.
const { createThumbs, isNavigation } = require('../../src/features/step-thumbs');
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(opts = {}) {
  const sent = [];
  let n = 0;
  let inflightMax = 0;
  let inflight = 0;
  const flags = { light: false, visible: true, same: false };
  const thumbs = createThumbs({
    capture: async () => { inflight++; inflightMax = Math.max(inflightMax, inflight); await sleep(5); inflight--; return { data: flags.same ? 'SAME' : `frame${++n}`, url: 'http://x/', title: 't', tabId: 1 }; },
    send: (e) => sent.push(e),
    light: () => flags.light, visible: () => flags.visible, intervalMs: 40, settleMs: 10, ...opts,
  });
  return { thumbs, sent, flags, inflightMax: () => inflightMax };
}

(async () => {
  {
    const r = rig();
    r.thumbs.activity();
    await sleep(200);
    r.thumbs.stop();
    await sleep(30); // (a capture already under way still lands, as the last frame)
    const after = r.sent.length;
    check('a run refreshes on a clock, starting with a first frame', after >= 3 && r.sent[0].type === 'thumb' && r.sent[0].tabId === 1, String(after));
    await sleep(120);
    check('after stop nothing more is captured', r.sent.length === after, `${r.sent.length} vs ${after}`);
    check('never two captures at once', r.inflightMax() === 1, String(r.inflightMax()));
  }
  {
    const r = rig({ intervalMs: 5000 });
    r.thumbs.activity();
    await sleep(60);
    const first = r.sent.length;
    r.thumbs.settled(false);
    await sleep(60);
    check('a finished step refreshes the frame soon after (a click or a load)', first === 1 && r.sent.length === 2, `${first} -> ${r.sent.length}`);
    r.thumbs.stop();
  }
  {
    const r = rig();
    r.flags.visible = false;
    r.thumbs.activity();
    await sleep(150);
    check('hidden or scrolled away: nothing is captured, not even a first frame', r.sent.length === 0, String(r.sent.length));
    r.flags.visible = true;
    await sleep(120);
    check('…and it resumes when the card is seen again', r.sent.length >= 1, String(r.sent.length));
    r.thumbs.stop();
  }
  {
    const r = rig();
    r.flags.light = true;
    r.thumbs.activity();
    await sleep(150);
    const first = r.sent.length;
    check('Light graphics: the first frame only, never the clock', first === 1, String(first));
    r.thumbs.settled(false);
    await sleep(60);
    check('Light graphics: a click that did not change the page adds nothing', r.sent.length === first, String(r.sent.length));
    r.thumbs.settled(true);
    await sleep(60);
    check('Light graphics: a navigation refreshes it', r.sent.length === first + 1, String(r.sent.length));
    r.thumbs.stop();
  }
  {
    const r = rig();
    r.flags.same = true;
    r.thumbs.activity();
    await sleep(200);
    check('a frame equal to the last one is not sent again', r.sent.length === 1, String(r.sent.length));
    r.thumbs.stop();
  }
  {
    const sent = [];
    const t = createThumbs({ capture: async () => { throw new Error('tab gone'); }, send: (e) => sent.push(e), intervalMs: 20, settleMs: 5 });
    t.activity();
    await sleep(100);
    check('a failed capture is skipped quietly and tried again', sent.length === 0, String(sent.length));
    t.stop();
  }
  // live: a probe (the page's signature) decides, so a moving page is about 3 frames a second and a still one none.
  // On a fake clock: the counts are ticks, not wall-clock time (a loaded CI machine ran fewer ticks in 520 ms and failed it).
  {
    const clock = (() => {
      let at = 0; let seq = 0; const q = [];
      const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
      return {
        now: () => at,
        setTimer: (fn, ms) => { const h = { id: ++seq, due: at + Math.max(0, Number(ms) || 0), fn, unref() {} }; q.push(h); return h; },
        clearTimer: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
        async advance(ms) {
          const until = at + ms;
          for (;;) {
            await drain();
            q.sort((a, b) => a.due - b.due || a.id - b.id);
            if (!q.length || q[0].due > until) break;
            const h = q.shift(); at = h.due; h.fn();
          }
          at = until; await drain();
        },
      };
    })();
    const sleep = (ms) => clock.advance(ms);
    let sigN = 0;
    let moving = true;
    const sent = [];
    let n = 0;
    const flags = { visible: true, light: false };
    const t = createThumbs({
      capture: async () => { await Promise.resolve(); return { data: `f${++n}`, url: 'http://x/', title: 't', tabId: 1 }; },
      probe: async () => (moving ? `s${++sigN}` : 'still'),
      send: (e) => sent.push(e), light: () => flags.light, visible: () => flags.visible, intervalMs: 50, settleMs: 10, hotMs: 100, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    t.activity();
    await sleep(520);
    const movingFrames = sent.length;
    check('a page that changes is refreshed on every tick (about 3 a second at the real 350 ms)', movingFrames >= 7 && movingFrames <= 12, String(movingFrames));
    moving = false;
    await sleep(250); // (the hot window after a step, then the page stands still)
    const settledAt = sent.length;
    await sleep(500);
    check('a page that stands still is not captured at all', sent.length === settledAt, `${settledAt} -> ${sent.length}`);
    t.settled(false);
    await sleep(80);
    check('…a finished step still gets one frame (a click can change a page without moving its signature)', sent.length > settledAt, String(sent.length));
    flags.visible = false;
    moving = true;
    await sleep(100); // (a capture already under way still lands)
    const afterStep = sent.length;
    await sleep(300);
    check('hidden or scrolled away: no probe-driven capture either', sent.length === afterStep, `${afterStep} -> ${sent.length}`);
    flags.visible = true;
    await sleep(200);
    check('…and it goes on when the card is seen again', sent.length > afterStep, String(sent.length));
    t.stop();
  }
  {
    let sigN = 0;
    const sent = [];
    let n = 0;
    const t = createThumbs({ capture: async () => { await sleep(3); return { data: `l${++n}`, url: 'u', tabId: 1 }; }, probe: async () => `s${++sigN}`, send: (e) => sent.push(e), light: () => true, intervalMs: 30, settleMs: 5 });
    t.activity();
    await sleep(250);
    check('Light graphics or software drawing: a moving page is not refreshed on the clock either', sent.length === 1, String(sent.length));
    t.stop();
  }
  {
    // the AI moves to another tab while a capture of the old one is under way: that frame is never shown
    const sent = [];
    let target = 'A';
    const t = createThumbs({
      capture: async () => { const mine = target; await sleep(40); return { data: `frame-${mine}`, url: 'u', tabId: mine === 'A' ? 1 : 2 }; },
      send: (e) => sent.push(e), intervalMs: 5000, settleMs: 5,
    });
    t.activity();
    await sleep(15); // (the capture of A has begun)
    target = 'B';
    t.retarget();
    await sleep(160);
    check('after retarget the capture of the old tab is dropped and the new tab is taken at once', sent.length === 1 && sent[0].data === 'frame-B' && sent[0].tabId === 2, JSON.stringify(sent));
    t.stop();
  }
  {
    // a frame taken for a step's end must not be followed right away by the clock's own frame.
    // On a virtual clock: real timers are only as exact as the OS's (Windows rounds them to ~15 ms, so one run gave gaps of 63..113 ms), and
    // this is about the order of events, not the speed of a machine. Every timer, the capture and the stamps below use the same virtual time.
    let vnow = 0;
    const timers = [];
    const setTimer = (fn, ms) => { const h = { at: vnow + ms, fn, seq: timers.length, unref() {} }; timers.push(h); return h; };
    const clearTimer = (h) => { const i = timers.indexOf(h); if (i !== -1) timers.splice(i, 1); };
    const flush = async () => { for (let k = 0; k < 20; k++) await Promise.resolve(); }; // (the async capture and probe settle between timers)
    const advance = async (ms) => {
      const end = vnow + ms;
      for (;;) {
        await flush();
        const next = timers.filter((h) => h.at <= end).sort((x, y) => x.at - y.at || x.seq - y.seq)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        vnow = next.at;
        next.fn();
      }
      vnow = end;
      await flush();
    };
    let n = 0;
    const at = [];
    const t = createThumbs({ capture: async () => { await new Promise((r) => setTimer(r, 3)); return { data: `g${++n}`, url: 'u', tabId: 1 }; }, probe: async () => `s${n}x`, send: () => at.push(vnow), intervalMs: 100, settleMs: 10, hotMs: 1000, now: () => vnow, setTimer, clearTimer });
    t.activity();
    for (let i = 0; i < 6; i++) { await advance(85); t.settled(false); } // (a step ends just before each tick would fire)
    await advance(150);
    t.stop();
    const gaps = at.slice(1).map((x, i) => x - at[i]);
    check('a frame for a step end is never followed right behind by a clock frame (gaps at least ~80 ms with a 100 ms clock)', at.length >= 5 && gaps.every((g) => g >= 80), JSON.stringify(gaps));
  }
  // streaming: the engine's screencast is the source while the card is on screen and the page moves
  const streamRig = (opts = {}) => {
    const sent = [];
    const st = { starts: 0, stops: 0, captures: 0, finals: 0, push: null, flags: { light: false, visible: true }, sig: 'a', refuse: false };
    const thumbs = createThumbs({
      capture: async () => { st.captures++; await sleep(2); return { data: 'captured' + st.captures, url: 'http://x/', title: 't', tabId: 1 }; },
      probe: async () => st.sig,
      stream: async ({ onFrame }) => { if (st.refuse) return null; st.starts++; st.push = onFrame; return { stop: () => { st.stops++; st.push = null; } }; },
      final: async () => { st.finals++; return { data: 'last', url: 'http://x/end', title: 'end', tabId: 2 }; },
      send: (e) => sent.push(e),
      light: () => st.flags.light, visible: () => st.flags.visible, intervalMs: 20, settleMs: 5, hotMs: 30, idleMs: 120, ...opts,
    });
    return { thumbs, sent, st };
  };
  {
    const r = streamRig();
    r.thumbs.activity();
    await sleep(60);
    check('a visible, active card streams: one stream is started, and nothing is captured on the clock', r.st.starts === 1 && r.st.captures === 0, JSON.stringify(r.st));
    for (let i = 0; i < 5; i++) r.st.push({ data: 'f' + i, url: 'http://x/', title: 't', tabId: 1 });
    r.st.push({ data: 'f4', url: 'http://x/', title: 't', tabId: 1 });
    check('frames of the stream go straight to the chat (an equal one is not sent again)', r.sent.length === 5 && r.sent[4].data === 'f4' && r.sent[0].type === 'thumb', String(r.sent.length));
    await sleep(400);
    check('a page that stands still sends nothing, and the stream rests after the idle time', r.sent.length === 5 && r.st.stops === 1 && r.st.starts === 1, JSON.stringify(r.st));
    r.st.sig = 'b';
    await sleep(80);
    check('the probe wakes it when the page moves', r.st.starts === 2, JSON.stringify(r.st));
    r.st.flags.visible = false;
    await sleep(80);
    check('a hidden or scrolled-away card stops the stream', r.st.stops === 2 && r.st.push === null, JSON.stringify(r.st));
    r.st.flags.visible = true;
    r.st.sig = 'c';
    await sleep(80);
    check('and it comes back when the card does', r.st.starts === 3, JSON.stringify(r.st));
    const before = r.sent.length;
    const oldPush = r.st.push;
    r.thumbs.retarget();
    oldPush({ data: 'stale', url: 'http://x/', title: 't', tabId: 1 });
    await sleep(60);
    check('retarget restarts the stream and a frame of the tab left is never shown', r.st.starts === 4 && r.sent.length === before && !r.sent.some((e) => e.data === 'stale'), JSON.stringify(r.st));
    r.thumbs.stop();
    await sleep(60);
    check('stop() ends the stream and takes one last frame of the tab the run ended on, which is the card\'s last frame', r.st.push === null && r.st.finals === 1 && r.sent[r.sent.length - 1].data === 'last' && r.sent[r.sent.length - 1].tabId === 2, JSON.stringify([r.st, r.sent[r.sent.length - 1]]));
    const n = r.sent.length;
    await sleep(100);
    check('after stop nothing more is sent', r.sent.length === n && r.st.starts === 4, String(r.sent.length));
  }
  {
    const r = streamRig({ stream: async () => null });
    r.thumbs.activity();
    await sleep(80);
    check('a page that cannot be streamed is captured instead (the old path)', r.st.captures >= 1 && r.sent.length >= 1 && r.sent[0].data.startsWith('captured'), JSON.stringify(r.st));
    r.thumbs.stop();
  }
  {
    const r = streamRig();
    r.st.flags.light = true;
    r.thumbs.activity();
    await sleep(80);
    check('on Light graphics there is no stream: a capture for the first frame only', r.st.starts === 0 && r.st.captures === 1, JSON.stringify(r.st));
    r.thumbs.settled(true);
    await sleep(40);
    check('…and one more for a navigation', r.st.captures === 2 && r.st.starts === 0, JSON.stringify(r.st));
    r.thumbs.stop();
  }
  check('navigation tools are told apart from clicks', isNavigation('navigate') && isNavigation('go_back') && isNavigation('mcp__lumen__open_tab') && !isNavigation('click') && !isNavigation('read_page'), '');

  // wiring: main starts it per run, gates it on the chat's report, and the chat reports visibility
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');
  const main = read('src/main.js');
  check('main notes every run event for the thumbnailer and stops it at done', /noteThumbs\(run, msg,/.test(main) && /msg\.type === 'done'\) run\.thumbs\?\.stop\(\)/.test(main), '');
  check('Light graphics and software drawing refresh on navigation only', /light: \(\) => graphicsMode\.light\(\) \|\| app\.isHardwareAccelerationEnabled\?\.\(\) === false/.test(main), '');
  check('the thumbnail respects the sites the AI may not read', /aiSites\.isOff\(url\)/.test(main), '');
  check('the new calls are gated (UI and chat page only)', /'agent:thumbs-visible', 'agent:open-preview'/.test(main) && /'agent:thumbs-visible', 'agent:open-preview'/.test(read('src/features/chat-page.js')), '');
  check('both preloads expose openPreview and thumbsVisible', ['src/preload/preload.js', 'src/features/chat-preload.js'].every((f) => /openPreview/.test(read(f)) && /thumbsVisible/.test(read(f))), '');
  check('the card follows the tab the step acts on (tab_id, switch_tab, read_tabs), else the run\'s own tab; read_urls is a site', /function thumbTargetOf\(run, name, input\)/.test(main) && /inp\.tab_id/.test(main) && /bare === 'read_urls'/.test(main) && /thumbs\.retarget\(\)/.test(main), '');
  check('the live refresh uses a cheap page probe and about 3 frames a second (350 ms), slower on Light graphics', /probe: \(\) => probeRunThumb\(run\)/.test(main) && /graphicsMode\.light\(\) \? 1500 : 350/.test(main) && /intervalMs = 350/.test(read('src/features/step-thumbs.js')), '');
  check('the card streams the engine\'s screencast (about 15 a second, paced by acknowledging late, the base64 passed on as it is) and takes one last frame of the tab the run ended on', main.includes('stream: ({ onFrame, onEnd }) => streamRunThumb(run, onFrame, onEnd)') && main.includes('final: (last) => finalRunThumb(run, last)') && main.includes('THUMB_FPS = Math.min(30, Math.max(1, Number(process.env.LUMEN_THUMB_FPS) || 15))') && read('src/features/tab-capture.js').includes('async function streamThumb'), '');
  { const cap = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'features', 'tab-capture.js'), 'utf8'); const poll = cap.slice(cap.indexOf('nothing is drawn for this view: poll it'), cap.indexOf('const poll = async')); check('a tab behind the one in front is polled across its whole width (not its top-left corner), at scale 1', /const cssW = w;/.test(poll) && !/Math.min(w, d+)/.test(poll) && /scale: 1/.test(cap.slice(cap.indexOf('const poll = async'), cap.indexOf('const poll = async') + 900)), poll.slice(0, 300)); }
  const ui = read('src/renderer/step-ui.js');
  check('the chat reports a card on screen with an IntersectionObserver and the page visibility', /IntersectionObserver/.test(ui) && /visibilitychange/.test(ui) && /thumbsVisible/.test(ui), '');
  check('a saved chat keeps one small final frame (≤ 60 KB as base64 text)', /THUMB_CHARS = 90000/.test(read('src/features/chat-branches.js')) && /maxBytes = 45000/.test(read('src/features/tab-capture.js')), '');
  const cap = read('src/features/tab-capture.js');
  check('a blank (one-colour) frame is never shown: it is redrawn once the other way, then the card shows the tab name', cap.includes('function isBlankFrame') && cap.includes('state.blank = true') && main.includes('return state.blank ? { blank: true, ...named } : null') && read('src/features/step-thumbs.js').includes("kind: 'blank'"), '');
  check('the live preview is sharp and never resizes the live page: one compositor-scaled screencast frame (340 CSS px x the display scale, quality 80), else the page pixels (clip inside the viewport, scale 1, no emulation); captures of a page run one at a time; Light / software keep a smaller picture', /SHOW_CSS = 340/.test(cap) && cap.includes('Page.startScreencast') && cap.includes('Math.round(SHOW_CSS * Math.max(1, dpr / zoom))') && cap.includes('quality: lowRes ? 55 : 80') && cap.includes('clip: { x: 0, y: 0, width: cssW, height: cssH, scale: 1 }') && !cap.includes('scale: Math.min(1,') && /function oneAtATime/.test(cap) && main.includes('captureThumb(wc, { lowRes, state })') && /const CAP = 340/.test(ui), '');
  check('the saved reply keeps the small frame: the sharp one is scaled down once when stamped', /shrinkThumb/.test(cap) && main.includes('thumb: savedThumb(d.thumb)'), '');
  check('chats saved before cards fall back to the old rows', /item\.cards && window\.stepUI/.test(read('src/renderer/chat-actions.js')), '');

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
