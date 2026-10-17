// [activity cards] The live thumbnail of the tab the AI works in, for the chat's Browser card. One per run (main.js emit).
// Plain data and timers, no Electron: `capture()` answers { data (base64 JPEG), url, title, tabId } or null; `send(event)` tells the chat.
//
//   activity()            a browser step started: the card is live from now on (a frame every `intervalMs`, about 3 a second, see below)
//   settled(navigation)   a browser step finished (the page may have changed): refresh once soon; `navigation`: it went to another page
//   retarget()            the step works in another tab than the one shown: forget the last frame, take one of the new tab at once
//                         (a capture of the old tab still under way is dropped, never shown)
//   stop()                the run ended: no more timers (a capture already under way, or one that was due, still lands, as the last frame)
//
// Live, but only while something moves: with a `probe()` (a cheap signature of the page: its address, scroll, size, how much is on it) a tick
// captures only when the signature changed, or within `hotMs` of a step starting or finishing (a click or a hover can change a page without
// touching the signature). A page standing still costs one tiny probe per tick and no capture. Without a probe every tick captures.
//
// Paused while the chat is hidden or scrolled away (visible() false). With Graphics on Light or no hardware drawing (light() true)
// only a navigation refreshes it. A frame equal to the last one is not sent again. Never two captures at once.
function createThumbs({ capture, probe = null, send, light = () => false, visible = () => true, intervalMs = 350, settleMs = 120, hotMs = 1500, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let running = false;
  let inflight = false;
  let timer = null;
  let settle = null;
  let lastData = '';
  let lastSig = null;
  let hotUntil = 0;
  let gen = 0; // bumped by retarget(): a frame begun before it belongs to the tab left
  let dirty = false; // something changed since the last capture that began
  let stopped = false;
  const heat = () => { hotUntil = now() + hotMs; };

  const arm = () => {
    if (timer || !running || stopped) return;
    timer = setTimer(() => { timer = null; tick(); }, intervalMs);
    timer.unref?.();
  };
  async function take() {
    if (inflight || stopped && !dirty) return;
    inflight = true;
    dirty = false;
    const mine = gen;
    try {
      const shot = await capture();
      if (mine === gen && shot && shot.blank) { // (only blank frames: the card shows the tab's name; the last good picture stays when it is the same tab)
        const key = 'blank:' + (shot.tabId ?? '');
        if (key !== lastData) { lastData = key; send({ type: 'thumb', kind: 'blank', data: '', url: shot.url || '', title: shot.title || '', tabId: shot.tabId ?? null, favicon: shot.favicon || null }); }
      } else if (mine === gen && shot && shot.data && shot.data !== lastData) { lastData = shot.data; send({ type: 'thumb', data: shot.data, url: shot.url || '', title: shot.title || '', tabId: shot.tabId ?? null }); }
    } catch { /* the tab is gone or not paintable right now: the next tick tries again */ } finally { inflight = false; }
    if (timer && running && !stopped) { clearTimer(timer); timer = null; arm(); } // (a frame taken for a step's end sets the clock back: the next tick is a whole interval after it, never right behind it)
    if (mine !== gen && dirty) take(); // (the tab changed while it was taken: take the new one now, even after the run ended)
  }
  async function tick() {
    if (!running) return;
    if (!light() && visible() && !inflight) {
      if (!probe) take();
      else {
        let sig = null;
        // (a page that does not answer in 400 ms, e.g. a tab the engine holds back, counts as changed: the card must never stall on its probe)
        try { sig = await Promise.race([probe(), new Promise((r) => { const h = setTimer(() => r('slow' + now()), 400); h.unref?.(); })]); } catch { /* the tab is gone or busy: the next tick tries again */ }
        if (sig != null && running && !inflight) {
          const moved = sig !== lastSig;
          lastSig = sig;
          if (moved || now() < hotUntil) take();
        }
      }
    }
    arm();
  }
  return {
    activity() {
      if (stopped) return;
      const first = !running;
      running = true;
      heat();
      if (first && visible()) { dirty = true; settle ||= setTimer(() => { settle = null; take(); }, settleMs); settle.unref?.(); } // the first frame
      arm();
    },
    settled(navigation = false) {
      if (stopped || !running) return;
      dirty = true;
      heat();
      if (!visible() || (light() && !navigation)) return;
      clearTimer(settle);
      settle = setTimer(() => { settle = null; take(); }, settleMs);
      settle.unref?.();
    },
    retarget() {
      if (stopped || !running) return;
      gen++;
      lastData = '';
      lastSig = null;
      dirty = true;
      heat();
      if (!visible() || light()) return;
      clearTimer(settle);
      settle = setTimer(() => { settle = null; take(); }, 0);
      settle.unref?.();
    },
    stop() {
      const lastFrame = dirty && settle !== null; // (a frame was about to be taken, e.g. of the tab the last step opened: it is the one the card keeps)
      stopped = true;
      running = false;
      clearTimer(timer);
      clearTimer(settle);
      timer = null;
      settle = null;
      if (lastFrame) take();
    },
    get lastData() { return lastData; },
  };
}

// The navigation tools: after one of these finishes the page is another page.
const NAVIGATION = new Set(['navigate', 'open_tab', 'go_back', 'go_forward', 'reload', 'switch_tab']);
const isNavigation = (name) => NAVIGATION.has(String(name || '').replace(/^mcp__lumen__/, ''));

module.exports = { createThumbs, isNavigation };
