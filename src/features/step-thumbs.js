// [activity cards] The live thumbnail of the tab the AI works in, for the chat's Browser card. One per run (main.js emit).
// Plain data and timers, no Electron: `capture()` answers { data (base64 JPEG), url, title, tabId } or null; `send(event)` tells the chat.
//
//   activity()            a browser step started: refresh about every 1.5 s from now on
//   settled(navigation)   a browser step finished (the page may have changed): refresh once soon; `navigation`: it went to another page
//   stop()                the run ended: no more timers (a capture already under way still lands, as the last frame)
//
// Paused while the chat is hidden or scrolled away (visible() false). With Graphics on Light or no hardware drawing (light() true)
// only a navigation refreshes it. A frame equal to the last one is not sent again. Never two captures at once.
function createThumbs({ capture, send, light = () => false, visible = () => true, intervalMs = 1500, settleMs = 250, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let running = false;
  let inflight = false;
  let timer = null;
  let settle = null;
  let lastData = '';
  let dirty = false; // something changed since the last capture that began
  let stopped = false;

  const arm = () => {
    if (timer || !running || stopped) return;
    timer = setTimer(() => { timer = null; tick(); }, intervalMs);
    timer.unref?.();
  };
  async function take() {
    if (inflight || stopped && !dirty) return;
    inflight = true;
    dirty = false;
    try {
      const shot = await capture();
      if (shot && shot.data && shot.data !== lastData) { lastData = shot.data; send({ type: 'thumb', data: shot.data, url: shot.url || '', title: shot.title || '', tabId: shot.tabId ?? null }); }
    } catch { /* the tab is gone or not paintable right now: the next tick tries again */ } finally { inflight = false; }
  }
  function tick() {
    if (!running) return;
    if (!light() && visible()) take();
    arm();
  }
  return {
    activity() {
      if (stopped) return;
      const first = !running;
      running = true;
      if (first && visible()) { dirty = true; settle ||= setTimer(() => { settle = null; take(); }, settleMs); settle.unref?.(); } // the first frame
      arm();
    },
    settled(navigation = false) {
      if (stopped || !running) return;
      dirty = true;
      if (!visible() || (light() && !navigation)) return;
      clearTimer(settle);
      settle = setTimer(() => { settle = null; take(); }, settleMs);
      settle.unref?.();
    },
    stop() {
      stopped = true;
      running = false;
      clearTimer(timer);
      clearTimer(settle);
      timer = null;
      settle = null;
    },
    get lastData() { return lastData; },
  };
}

// The navigation tools: after one of these finishes the page is another page.
const NAVIGATION = new Set(['navigate', 'open_tab', 'go_back', 'go_forward', 'reload', 'switch_tab']);
const isNavigation = (name) => NAVIGATION.has(String(name || '').replace(/^mcp__lumen__/, ''));

module.exports = { createThumbs, isNavigation };
